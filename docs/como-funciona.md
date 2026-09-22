# Como o `implementar-spec` funciona por dentro

Este documento detalha o que o [README](../README.md) resume: as fases, o que cada agente recebe e devolve, a lógica determinística que o script executa entre os agentes e as garantias de desenho.

## Duas camadas: script e agentes

Um workflow do Claude Code tem duas camadas. O **script** (`workflows/implementar-spec.js`) é código determinístico: decide a ordem das fases, monta as ondas, controla os loops de revisão e aceite, e junta os resultados. Os **agentes** são sessões de Claude com contexto limpo, cada uma recebendo um prompt específico e devolvendo uma resposta estruturada (um objeto com campos definidos por schema, não texto livre). O script nunca "interpreta" o que um agente disse: ele lê campos como `verdict`, `status` ou `complete` e decide o próximo passo com base neles.

Isso importa porque a parte que precisa ser confiável (não pular a revisão, não aprovar por omissão, não rodar duas unidades no mesmo arquivo ao mesmo tempo) fica no script, onde não há criatividade envolvida.

## Fase 1: Entender

Um único agente, o planejador, recebe a spec e a instrução de como obtê-la. Se for um identificador do Linear, ele carrega a ferramenta do Linear e lê a issue inteira, incluindo comentários e documentos referenciados. Se for um caminho de arquivo, lê o arquivo. Caso contrário, trata o texto como a spec.

Depois ele estuda a base de código o suficiente para planejar: estrutura, stack, convenções, como os testes rodam. E decompõe a spec em unidades de trabalho. Cada unidade carrega:

- uma descrição autossuficiente, escrita para alguém que nunca viu a spec;
- os arquivos exatos que ela cria ou altera;
- as unidades de que depende;
- critérios de aceite verificáveis;
- edge cases e testes a escrever.

Se a spec deixa algo em aberto, o planejador registra em `openQuestions`, escolhe a interpretação mais conservadora e diz qual foi. Se não encontra a spec, retorna `specFound=false` e o workflow para ali, com a explicação.

## Fase 2: Criticar plano

Um segundo agente recebe o plano e relê a spec na fonte, por conta própria. O prompt o instrui a partir do pressuposto de que há algum problema até se convencer do contrário, e a verificar seis coisas: cobertura (todo requisito está em alguma unidade?), autossuficiência (dá para implementar cada unidade lendo só a descrição?), conflitos (unidades sem dependência declarada que tocam os mesmos arquivos), critérios vagos, realismo dos caminhos de arquivo (ele confere no repositório) e trabalho fora de escopo.

Se o crítico reprova, o planejador recebe o plano anterior mais a crítica e produz um plano revisado completo. Isso acontece uma vez; se o replanejamento falhar, o workflow segue com o plano original e registra isso no log.

## Fase 3: Implementar

Aqui entra a lógica determinística mais importante do script: a montagem das **ondas**.

Uma onda é um conjunto de unidades que podem rodar em paralelo com segurança. Uma unidade entra numa onda quando duas condições valem: todas as unidades de que ela depende já ficaram prontas em ondas anteriores, e nenhum dos seus arquivos aparece em outra unidade da mesma onda. Se duas unidades independentes tocam o mesmo arquivo, a segunda espera a próxima onda. Se o planejador criou uma dependência circular, o script detecta, avisa no log e roda essas unidades em sequência.

Exemplo: cinco unidades em que U2 depende de U1, U3 depende de U2, U4 é independente e U5 é independente mas mexe no mesmo arquivo de U1. As ondas ficam `U1+U4 → U2+U5 → U3`. U5 não entra na primeira onda por causa do arquivo compartilhado, mas entra na segunda porque nada mais a bloqueia.

Dentro de uma onda, cada unidade ganha um implementador próprio rodando em paralelo. O prompt do implementador diz explicitamente que outros agentes estão trabalhando no mesmo repositório ao mesmo tempo, e impõe regras: ler o código vizinho antes de escrever, tocar só os arquivos listados (mais os testes correspondentes), escrever testes que exercitem comportamento real, rodar só os testes da própria unidade (nunca a suíte completa, que é papel do integrador), não fazer commit nem mexer em branch, e escolher a opção conservadora quando a spec for omissa, registrando a decisão em vez de parar para perguntar. Se algo bloqueia, ele retorna `status=blocked` com os motivos.

## Fase 4: Revisar

Cada unidade implementada vai para um revisor que não é o implementador. O revisor recebe o contexto da unidade e o que o implementador *diz* ter feito, com a instrução de não confiar nesse resumo e conferir no código: `git diff` nos arquivos, leitura dos arquivos novos, leitura dos pontos de uso para detectar quebras, execução dos testes da unidade.

Ele classifica os achados em `critical` (bug, falha de segurança, critério não atendido), `major` (edge case descoberto, teste inadequado, convenção importante quebrada) e `minor` (estilo). Só aprova se todos os critérios estão atendidos e não há achados critical ou major. O revisor não altera arquivos.

Quando o revisor pede mudanças, um agente corretor recebe os achados e corrige só aquilo, com as mesmas regras do implementador. Se discordar de um achado, precisa explicar por que não alterou, em vez de ignorar em silêncio. Depois o revisor olha de novo. Esse ciclo se repete até a aprovação ou até esgotar `rodadasRevisao` (padrão 2, ou seja, duas revisões e uma correção). Se esgotar sem aprovação, a unidade fica marcada como não aprovada e os achados não triviais viram `pendenciasDoRevisor` no resultado final. Nada é aprovado por omissão: um agente que não responde vira `skipped`, não `ok`.

Unidades que voltaram como `blocked` do implementador pulam a revisão e vão direto para o relatório como bloqueadas.

## Fase 5: Integrar

Quando todas as unidades de uma onda terminam, um único agente integrador roda a suíte completa de testes, o lint e o typecheck. Ele recebe a lista das unidades da onda com os arquivos alterados e o status de revisão de cada uma. Se algo falha, ele determina pelo diff se a falha veio desta onda; se veio, corrige com o mínimo de alteração e sem mudar o comportamento pedido pela spec; se é uma falha pré-existente e não relacionada, registra em `remainingProblems` e não tenta corrigir. É proibido desabilitar, apagar ou enfraquecer testes para fazê-los passar.

A integração acontece ao fim de **cada** onda, não só no final. Isso pega quebras cedo, quando ainda é barato entender de onde vieram.

## Fase 6: Aceitar

Depois de todas as ondas, um agente novo faz o aceite. Ele relê a spec na fonte original (não confia no resumo do planejador), lista cada requisito que ela impõe, vê tudo que mudou no repositório e procura a evidência de cada requisito no código e nos testes.

Tudo que não foi implementado, foi implementado parcialmente ou foi implementado de um jeito que muda o sentido do requisito vai para `requirementsMissing`, com os arquivos que provavelmente precisam mudar e uma abordagem sugerida. Esses itens viram unidades complementares (identificadas como `G1.1`, `G1.2` e assim por diante) que passam pelo mesmo ciclo de implementar, revisar e integrar. Depois o aceite roda de novo. O limite é `rodadasAceite` (padrão 1): se ainda faltar algo depois disso, fica no relatório como pendente.

`complete=true` só quando `requirementsMissing` está vazio.

## Fase 7: Reportar

O aceite produz um relatório em markdown para leitor não técnico: o que foi entregue, o que ficou de fora e por quê, decisões dos agentes que merecem validação humana, perguntas em aberto e um roteiro curto de teste manual.

Se a spec veio do Linear e `reportarNoLinear` não foi desligado, um agente publica esse relatório como comentário na issue, sem alterar status, responsável ou qualquer outro campo. Se `commit` foi ligado, um agente cria um único commit com as mudanças, conferindo antes que não há arquivos temporários ou segredos sendo adicionados. Por padrão nada é commitado: as mudanças ficam no working tree para revisão humana.

## O que o workflow devolve

O resultado final é um objeto com: a spec e sua fonte, o resumo do plano, cada unidade com status, aprovação do revisor, arquivos, testes, decisões, bloqueios e pendências do revisor, o resultado de cada integração, o aceite (requisitos atendidos, faltando, regressões suspeitas), as perguntas em aberto, o relatório em markdown e o resultado das etapas de Linear e commit, quando rodaram.

## Garantias de desenho

- Ninguém revisa o próprio código. Implementador, revisor, integrador e aceitador são sempre agentes diferentes, com contexto limpo.
- Nada fica aprovado por omissão. Agente que não responde vira `skipped` ou `pendente`, nunca `ok`.
- Paralelismo só com arquivos disjuntos. É o que dispensa worktrees separados. Depende do planejador declarar bem os arquivos, e o crítico verifica exatamente isso.
- A suíte completa roda ao fim de cada onda, não só no final.
- As mudanças ficam sem commit a menos que se peça o contrário.
- Todos os agentes herdam o modelo da sessão. O script só varia o esforço de raciocínio: alto nas etapas de julgamento (planejar, criticar, revisar, aceitar), baixo nas mecânicas (Linear, commit).

## Validação

O script foi validado em simulação com agentes falsos, em cinco cenários: caminho feliz com spec do Linear, crítico reprovando o plano e revisor devolvendo correções até esgotar as rodadas, spec não encontrada, agentes que não respondem combinados com dependências circulares, e chamada sem spec. A simulação confere a ordem das ondas, o paralelismo real dentro da onda, os loops de revisão e aceite, e que nenhum prompt sai com campos vazios ou malformados.

## Limites conhecidos

- Se dois implementadores da mesma onda rodarem testes que compartilham recursos externos (um banco de dados local, uma porta fixa), pode haver interferência. A regra de rodar só os testes da própria unidade reduz isso, mas não elimina. Projetos com testes de integração pesados se beneficiam de `escopo` menor por execução.
- O planejador pode errar os arquivos de uma unidade. Quando isso acontece, o implementador registra em `decisions` que precisou tocar arquivos fora da lista, e o revisor e o aceite conseguem ver o efeito. Mas a garantia de arquivos disjuntos vale para o que foi *declarado*, não para o que foi *tocado*.
- Specs muito grandes geram muitas unidades e muitas ondas. Fatie com `escopo`.

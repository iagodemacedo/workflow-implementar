# workflow-implementar

Workflow multiagente para o [Claude Code](https://code.claude.com/docs/en/workflows) que pega uma spec pronta (issue do Linear, trecho de PRD ou uma descrição em texto) e entrega código implementado, testado, revisado por agentes independentes e confrontado com a spec original, requisito por requisito.

A ideia central é simples: ninguém revisa o próprio trabalho. Um agente planeja, outro critica o plano, cada unidade de trabalho ganha um implementador e um revisor diferentes, um integrador roda a suíte completa e um último agente faz o aceite contra a spec, como um PM exigente faria antes de apresentar a feature.

## Requisitos

- Claude Code com a funcionalidade de workflows habilitada. Está disponível nos planos pagos; no plano Pro, ligue a opção **Dynamic workflows** em `/config`.
- Para usar issues do Linear como spec, o MCP do Linear precisa estar conectado à sua sessão do Claude Code. Sem ele, o workflow continua funcionando com arquivos e texto.

## Instalação

Para ter o comando em qualquer projeto da sua máquina (só para você):

```bash
mkdir -p ~/.claude/workflows && curl -fsSL https://raw.githubusercontent.com/iagodemacedo/workflow-implementar/main/workflows/implementar-spec.js -o ~/.claude/workflows/implementar-spec.js
```

Para instalar em um repositório específico (quem clonar o repo passa a ter o comando), rode dentro da pasta do projeto:

```bash
mkdir -p .claude/workflows && curl -fsSL https://raw.githubusercontent.com/iagodemacedo/workflow-implementar/main/workflows/implementar-spec.js -o .claude/workflows/implementar-spec.js
```

Se o mesmo nome existir nos dois lugares, o do repositório vence. O Claude Code lê essas pastas quando a sessão começa, então abra uma sessão nova e digite `/` para conferir se `implementar-spec` aparece na lista.

## Uso

Dentro do Claude Code, no repositório em que a feature vai ser implementada:

```
/implementar-spec MAR-12
/implementar-spec docs/PRD.md#exportacao-csv
/implementar-spec "Adicionar exportação CSV na tela de relatórios"
```

O workflow descobre sozinho de onde vem a spec: um identificador no formato `ABC-123` é tratado como issue do Linear, um caminho terminando em `.md` (com seção opcional após `#`) é lido do repositório, e qualquer outra coisa é tratada como a própria spec.

Opções, em linguagem natural na mesma mensagem:

| Opção | O que faz | Padrão |
|---|---|---|
| `escopo` | Delimita o que implementar dentro de uma spec grande ("só o backend", "só a tela de listagem") | vazio (spec inteira) |
| `rodadasRevisao` | Quantas vezes o revisor pode devolver uma unidade antes de marcá-la para revisão humana | 2 |
| `rodadasAceite` | Quantas vezes o aceite final pode abrir unidades complementares para o que ficou faltando | 1 |
| `reportarNoLinear` | Publica o relatório final como comentário na issue (só quando a spec veio do Linear) | true |
| `commit` | Cria um commit ao final com todas as mudanças | false |

Exemplo: "roda /implementar-spec MAR-12 com escopo só o backend, rodadasRevisao 3 e commit true".

Para acompanhar, `/workflows` abre a árvore de progresso: cada fase, cada agente, tokens gastos e o que cada um retornou. Dá para pausar, retomar e parar por ali.

## Como funciona

Sete fases, em ordem:

1. **Entender.** Um planejador lê a spec na fonte e a base de código (stack, convenções, como os testes rodam) e decompõe tudo em unidades de trabalho autossuficientes, cada uma com arquivos exatos, dependências, critérios de aceite, edge cases e testes a escrever.
2. **Criticar plano.** Um segundo agente, sem ter visto o raciocínio do primeiro, procura lacunas: requisito sem unidade, unidades que colidem em arquivo, critério vago, caminho de arquivo que não existe. Se reprovar, o planejador refaz o plano incorporando a crítica.
3. **Implementar.** As unidades são organizadas em ondas: uma unidade só entra quando suas dependências ficaram prontas, e duas unidades que tocam o mesmo arquivo nunca ficam na mesma onda. Dentro da onda, cada unidade ganha um agente próprio rodando em paralelo, com regras rígidas: só toca os arquivos listados, roda apenas os testes da própria unidade, não faz commit, e se a spec for omissa escolhe a opção conservadora e registra a decisão.
4. **Revisar.** Para cada unidade, um revisor independente confere o diff contra os critérios de aceite com postura cética. Se pedir mudanças, um agente corrige e o revisor olha de novo, até o limite de rodadas. Quando o limite estoura sem aprovação, a unidade fica marcada como pendente de revisão humana, com os problemas listados.
5. **Integrar.** Ao fim de cada onda, um único agente roda a suíte completa, lint e typecheck, e corrige o que a onda quebrou. É proibido enfraquecer ou apagar testes para passar.
6. **Aceitar.** Um agente novo relê a spec original e confronta o resultado inteiro, requisito por requisito. O que estiver faltando vira unidades complementares, que passam pelo mesmo ciclo. Depois o aceite roda de novo.
7. **Reportar.** Sai um relatório em markdown para leitor não técnico: o que foi entregue, o que ficou de fora e por quê, decisões dos agentes que merecem validação humana, perguntas em aberto e roteiro de teste manual. Se a spec veio do Linear, o relatório vai como comentário na issue.

O detalhamento de cada fase, os contratos de dados entre agentes e as garantias de desenho estão em [docs/como-funciona.md](docs/como-funciona.md).

## Modelo e custo

Todos os agentes herdam o modelo da sessão em que o workflow foi chamado. O que varia é o esforço de raciocínio: planejador, crítico, revisores e aceite rodam com esforço alto; as etapas mecânicas (comentário no Linear, commit) rodam com esforço baixo.

Uma spec de umas 5 unidades gasta entre 15 e 25 agentes. Para specs grandes, use `escopo` para fatiar em execuções menores. O Claude Code avisa quando um run projeta mais de 25 agentes ou 1,5M de tokens.

## Versão curta: `implementar-spec-curto`

O repositório traz duas versões, lado a lado. A completa (`implementar-spec`) é a descrita acima. A curta (`workflows/implementar-spec-curto.js`) faz o mesmo percurso com **4 a 6 agentes** em vez de 15 a 25, para quando o custo e o tempo da completa não compensam.

Ela nasceu de uma medição em projeto real: nas primeiras 7 issues, a versão completa usou 411 agentes. A maior parte do tempo ia para revisões por unidade que se sobrepunham ao aceite final, e a suíte inteira rodava várias vezes na mesma issue.

O que muda:

| | Completa | Curta |
|---|---|---|
| Plano | planejador, crítico e replanejamento | só o planejador, com no máximo 2 fatias |
| Implementação | um agente por unidade, em ondas | 1 ou 2 agentes, e cada um confere uma lista de pontos sensíveis antes de entregar |
| Revisão | um revisor por unidade, com até 2 rodadas de correção | um único revisor independente no fim, contra a spec e a mesma lista |
| Faltas do aceite | uma unidade complementar por falta, depois novo aceite | um único corretor para todas as faltas, sem segundo aceite |
| Testes | suíte inteira ao fim de cada onda | lint e testes dos arquivos tocados; suíte inteira no merge, ou no integrador com `suiteCompleta` |
| Commit e Linear | agentes próprios | feitos pelo integrador, pelo revisor ou pelo corretor, sem agente extra |

O que não muda: ninguém revisa o próprio trabalho, e o resultado é confrontado com a spec original requisito por requisito.

Instalação, igual à da completa:

```bash
mkdir -p ~/.claude/workflows && curl -fsSL https://raw.githubusercontent.com/iagodemacedo/workflow-implementar/main/workflows/implementar-spec-curto.js -o ~/.claude/workflows/implementar-spec-curto.js
```

Uso: `/implementar-spec-curto MAR-12`. Opções, em linguagem natural na mesma mensagem:

| Opção | O que faz | Padrão |
|---|---|---|
| `listaSensivel` | Os pontos que o implementador confere e o revisor reconfere. Troque pelas regras que não podem quebrar no seu projeto | segredos, validação e autorização, edge cases sem teste, regressão e escopo |
| `suiteCompleta` | O integrador roda a suíte inteira, em vez de só os testes dos arquivos tocados | false |
| `raiz` | Caminho de um git worktree, para rodar várias issues em paralelo sem misturar os diffs | o repositório atual |
| `base` | Branch contra a qual o revisor lê o diff | main |
| `reportarNoLinear` | Publica o relatório como comentário na issue | true |

A curta sempre faz commit, porque o revisor lê o diff commitado contra a `base`. Com `suiteCompleta` desligada, rode a suíte inteira antes do merge (no CI ou à mão): é a prova que o workflow deixa para depois.

A versão curta é nova e ainda está sendo medida. Os números de tempo e custo entram aqui quando houver issues suficientes rodadas com ela.

## Para quem escreve specs

O workflow rende mais quando a spec já vem escrita para ser executada por agentes: contexto, regras exatas, edge cases e critérios de aceite verificáveis. Issues assim reduzem as perguntas em aberto do planejador e as rodadas de revisão. Uma spec vaga não quebra o workflow, mas o aceite final vai devolver mais itens como "implementado com interpretação conservadora, validar com humano".

## Licença

MIT. Veja [LICENSE](LICENSE).

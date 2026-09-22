// Workflow: implementar-spec
// Salve em .claude/workflows/implementar-spec.js (do projeto) ou ~/.claude/workflows/ (pessoal)
// Uso: /implementar-spec MAR-12
//      /implementar-spec docs/PRD.md#checkout
//      /implementar-spec "Adicionar exportação CSV na tela de relatórios"
// Opções (em linguagem natural ou como objeto em args):
//   escopo:           delimita o que implementar dentro de uma spec grande
//   rodadasRevisao:   quantas vezes o revisor pode devolver uma unidade (padrão 2)
//   rodadasAceite:    quantas vezes o aceite final pode abrir novas unidades (padrão 1)
//   reportarNoLinear: publicar o relatório como comentário na issue (padrão true, só para specs do Linear)
//   commit:           criar um commit ao final (padrão false)

export const meta = {
  name: 'implementar-spec',
  description: 'Implementa uma spec (issue do Linear, PRD ou texto) com agentes que planejam, codificam, revisam e validam',
  whenToUse: 'Quando existe uma spec pronta (issue do Linear, trecho de PRD ou descrição de feature) e o objetivo é sair com código funcionando, testado e revisado por agentes independentes',
  phases: [
    { title: 'Entender', detail: 'ler a spec e a base de código, decompor em unidades de trabalho' },
    { title: 'Criticar plano', detail: 'um crítico independente procura lacunas no plano antes de codificar' },
    { title: 'Implementar', detail: 'um agente por unidade, em ondas que respeitam dependências' },
    { title: 'Revisar', detail: 'revisor independente por unidade, com rodadas de correção' },
    { title: 'Integrar', detail: 'suíte completa de testes ao fim de cada onda' },
    { title: 'Aceitar', detail: 'confronto final do resultado com a spec original' },
    { title: 'Reportar', detail: 'relatório final e, se for o caso, comentário na issue do Linear' },
  ],
}

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

const cfg = typeof args === 'string'
  ? { spec: args }
  : (args && typeof args === 'object' ? args : {})

if (!cfg.spec || typeof cfg.spec !== 'string') {
  throw new Error('Informe a spec: identificador de issue do Linear (ex.: MAR-12), caminho de arquivo (ex.: docs/PRD.md#secao) ou um texto descrevendo a feature.')
}

const SPEC = cfg.spec.trim()
const ESCOPO = typeof cfg.escopo === 'string' ? cfg.escopo.trim() : ''
const RODADAS_REVISAO = Number.isInteger(cfg.rodadasRevisao) && cfg.rodadasRevisao >= 1 ? cfg.rodadasRevisao : 2
const RODADAS_ACEITE = Number.isInteger(cfg.rodadasAceite) && cfg.rodadasAceite >= 0 ? cfg.rodadasAceite : 1
const REPORTAR_LINEAR = cfg.reportarNoLinear !== false
const FAZER_COMMIT = cfg.commit === true

const pareceLinear = /^[A-Z][A-Z0-9]*-\d+$/.test(SPEC)
const pareceArquivo = /^[\w@./\\-]+\.(md|mdx|txt|json|ya?ml|rst)(#.*)?$/i.test(SPEC)
const dicaFonte = pareceLinear
  ? 'Isso parece um identificador de issue do Linear.'
  : pareceArquivo
    ? 'Isso parece o caminho de um arquivo do repositório (a parte após # indica uma seção).'
    : 'Isso parece ser o texto da própria spec, ou uma referência que você precisa interpretar.'

const lista = (arr) => (Array.isArray(arr) && arr.length) ? arr.map(x => `- ${x}`).join('\n') : '- (nenhum)'

const COMO_OBTER_SPEC = `Como obter a spec "${SPEC}":
- Se for um identificador do Linear (ex.: MAR-12), carregue a ferramenta mcp__Linear__get_issue via ToolSearch e leia a issue completa: descrição, comentários, anexos e documentos referenciados. Se a issue apontar para arquivos do repositório (PRD.md, ROUTES.md, DESIGN.md e similares), leia-os também.
- Se for um caminho de arquivo, leia o arquivo inteiro e concentre-se na seção indicada após #, se houver.
- Caso contrário, trate o texto como a própria spec.
${dicaFonte}${ESCOPO ? `\nESCOPO: implemente apenas o seguinte recorte da spec: ${ESCOPO}` : ''}`

// ---------------------------------------------------------------------------
// Schemas (o contrato de saída de cada agente)
// ---------------------------------------------------------------------------

const UNIDADE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Identificador curto e estável, ex.: U1, U2' },
    title: { type: 'string' },
    description: { type: 'string', description: 'Descrição autossuficiente: um agente que nunca viu a spec precisa conseguir implementar só com isto' },
    files: { type: 'array', items: { type: 'string' }, description: 'Caminhos exatos dos arquivos a criar ou alterar' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'ids de unidades que precisam estar prontas antes' },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    edgeCases: { type: 'array', items: { type: 'string' } },
    testsToWrite: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'title', 'description', 'files', 'dependsOn', 'acceptanceCriteria'],
}

const PLANO_SCHEMA = {
  type: 'object',
  properties: {
    specFound: { type: 'boolean' },
    source: { type: 'string', enum: ['linear', 'file', 'inline', 'unknown'] },
    linearIssueId: { type: 'string', description: 'Identificador da issue (ex.: MAR-12) quando a fonte for o Linear' },
    specSummary: { type: 'string', description: 'Resumo fiel da spec, em português, com os requisitos principais' },
    stack: { type: 'string', description: 'Stack, estrutura do repositório e convenções relevantes' },
    testCommand: { type: 'string', description: 'Comando que roda a suíte completa de testes' },
    lintCommand: { type: 'string', description: 'Comando de lint e/ou typecheck, se existir' },
    openQuestions: { type: 'array', items: { type: 'string' } },
    units: { type: 'array', items: UNIDADE_SCHEMA },
  },
  required: ['specFound', 'source', 'specSummary', 'stack', 'testCommand', 'openQuestions', 'units'],
}

const CRITICA_SCHEMA = {
  type: 'object',
  properties: {
    approved: { type: 'boolean' },
    coverageGaps: { type: 'array', items: { type: 'string' }, description: 'Requisitos da spec sem unidade correspondente' },
    ambiguities: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'string' }, description: 'Unidades que colidem em arquivos ou têm dependências não declaradas' },
    outOfScope: { type: 'array', items: { type: 'string' } },
    suggestedChanges: { type: 'string' },
  },
  required: ['approved', 'coverageGaps', 'ambiguities', 'conflicts', 'outOfScope', 'suggestedChanges'],
}

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'array', items: { type: 'string' } },
    testsPassing: { type: 'boolean' },
    testOutputSummary: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' }, description: 'Decisões tomadas onde a spec era omissa' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary', 'filesChanged', 'testsAdded', 'testsPassing', 'decisions', 'blockers'],
}

const REVISAO_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approved', 'changes_requested'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          file: { type: 'string' },
          description: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
        required: ['severity', 'description'],
      },
    },
    missingCriteria: { type: 'array', items: { type: 'string' } },
    testsAdequate: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['verdict', 'findings', 'missingCriteria', 'testsAdequate'],
}

const INTEGRACAO_SCHEMA = {
  type: 'object',
  properties: {
    testsPassing: { type: 'boolean' },
    lintPassing: { type: 'boolean' },
    fixesApplied: { type: 'array', items: { type: 'string' } },
    remainingProblems: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['testsPassing', 'lintPassing', 'fixesApplied', 'remainingProblems', 'summary'],
}

const ACEITE_SCHEMA = {
  type: 'object',
  properties: {
    complete: { type: 'boolean' },
    requirementsMet: { type: 'array', items: { type: 'string' } },
    requirementsMissing: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          requirement: { type: 'string' },
          why: { type: 'string', description: 'Por que está faltando ou incompleto' },
          files: { type: 'array', items: { type: 'string' }, description: 'Arquivos que provavelmente precisam mudar' },
          suggestedApproach: { type: 'string' },
        },
        required: ['requirement', 'why', 'files', 'suggestedApproach'],
      },
    },
    regressionsSuspected: { type: 'array', items: { type: 'string' } },
    report: { type: 'string', description: 'Relatório em markdown, em português, para leitor não técnico' },
  },
  required: ['complete', 'requirementsMet', 'requirementsMissing', 'regressionsSuspected', 'report'],
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const REGRAS_PLANO = `Regras para a decomposição em unidades:
- Cada unidade deve ser implementável por um agente sozinho, com contexto limpo, lendo apenas a própria descrição. Escreva a descrição como se fosse para alguém que nunca viu a spec.
- Liste os arquivos exatos que a unidade deve criar ou alterar. Duas unidades que precisem tocar o mesmo arquivo NÃO rodam em paralelo, então prefira dividir por arquivo ou módulo, e declare dependsOn quando uma unidade precisar do resultado de outra.
- Critérios de aceite verificáveis: coisas que um revisor consegue checar com um teste ou uma leitura objetiva.
- Edge cases relevantes e quais testes escrever.
- Ordene para que fundações (modelos, migrações, tipos, contratos de API) venham antes das camadas que dependem delas.
- Não inclua trabalho fora do escopo da spec (refatorações oportunistas, melhorias não pedidas).
- Se a spec deixa algo em aberto que impede planejar, registre em openQuestions, escolha a interpretação mais conservadora e diga qual foi.`

const promptPlanejador = () => `Você é o planejador técnico de um workflow que vai implementar uma spec com vários agentes trabalhando em paralelo. Sua saída é o contrato que todos os outros agentes vão seguir, então seja preciso e concreto.

${COMO_OBTER_SPEC}
Se não conseguir localizar a spec, retorne specFound=false e explique em specSummary o que tentou.

Depois de obter a spec, entenda a base de código o suficiente para planejar: estrutura de pastas, stack, convenções e como os testes rodam (procure package.json, Makefile, pyproject, CLAUDE.md, AGENTS.md, README). Identifique o comando que roda a suíte completa de testes e, se existirem, lint e typecheck.

${REGRAS_PLANO}`

const promptCritico = (plano) => `Você é um crítico independente de planejamento técnico. Recebeu um plano de implementação gerado por outro agente a partir de uma spec. Seu papel é encontrar o que está faltando, o que está ambíguo e o que vai dar problema quando vários agentes implementarem em paralelo. Parta do pressuposto de que existe algum problema até se convencer do contrário.

Releia a spec na fonte original, do mesmo jeito que o planejador fez:
${COMO_OBTER_SPEC}

PLANO A CRITICAR:
${JSON.stringify(plano, null, 2)}

Verifique:
1. Cobertura: todo requisito da spec está em alguma unidade? Liste em coverageGaps os que não estão.
2. Autossuficiência: cada unidade pode ser implementada lendo só a própria descrição? Onde faltaria contexto?
3. Conflitos: unidades sem dependência declarada que tocam os mesmos arquivos ou dependem uma da outra de fato.
4. Critérios de aceite: são verificáveis ou vagos?
5. Realismo: os caminhos de arquivo existem ou fazem sentido na estrutura real do repositório? Confira no repositório.
6. Fora de escopo: alguma unidade inventa trabalho que a spec não pediu?

Aprove (approved=true) apenas se não houver lacunas relevantes. Em suggestedChanges, descreva objetivamente o que o planejador deve mudar. Não altere nenhum arquivo.`

const promptReplanejar = (plano, critica) => `Você é o planejador técnico de um workflow que vai implementar uma spec com vários agentes em paralelo. Um crítico independente revisou seu plano anterior e apontou problemas. Produza o plano revisado COMPLETO (não um diff), incorporando as críticas que fizerem sentido. O que preferir não acatar, explique em openQuestions.

${COMO_OBTER_SPEC}

PLANO ANTERIOR:
${JSON.stringify(plano, null, 2)}

CRÍTICA RECEBIDA:
${JSON.stringify(critica, null, 2)}

${REGRAS_PLANO}`

const contextoUnidade = (plano, unidade) => `CONTEXTO DA FEATURE: ${plano.specSummary}

STACK E CONVENÇÕES: ${plano.stack}

UNIDADE: ${unidade.id} · ${unidade.title}
${unidade.description}

ARQUIVOS DA UNIDADE (criar ou alterar):
${lista(unidade.files)}

CRITÉRIOS DE ACEITE:
${lista(unidade.acceptanceCriteria)}

EDGE CASES:
${lista(unidade.edgeCases)}

TESTES A ESCREVER:
${lista(unidade.testsToWrite)}`

const REGRAS_IMPLEMENTACAO = `Regras:
1. Antes de escrever, leia os arquivos envolvidos e o código vizinho para seguir as convenções existentes (nomes, padrões, bibliotecas já usadas). Não introduza dependências novas sem necessidade real.
2. Altere apenas os arquivos listados, mais os arquivos de teste correspondentes. Se for inevitável tocar outro arquivo, faça o mínimo e registre em decisions.
3. Escreva testes que exercitem comportamento real (entradas e saídas esperadas), não testes que só confirmam que a função existe.
4. Rode SOMENTE os testes relacionados aos seus arquivos (filtre pelo caminho ou nome do teste). Não rode a suíte completa nem lint global: outros agentes estão trabalhando em paralelo neste repositório e a integração completa acontece depois.
5. Não faça commit, não mude de branch, não use git stash.
6. Se a spec não cobrir uma decisão necessária, escolha a opção mais conservadora e registre em decisions. Não pare para perguntar.
7. Se algo impedir a conclusão (arquivo esperado não existe, dependência quebrada), retorne status=blocked com blockers claros em vez de improvisar fora do escopo.`

const promptImplementar = (plano, unidade, dependenciasProntas) => `Você é o engenheiro responsável por UMA unidade de trabalho de uma feature maior. Outros agentes estão implementando outras unidades AO MESMO TEMPO neste mesmo repositório, então respeite estritamente os limites da sua unidade.

${contextoUnidade(plano, unidade)}

UNIDADES JÁ CONCLUÍDAS DE QUE VOCÊ DEPENDE:
${lista(dependenciasProntas)}

${REGRAS_IMPLEMENTACAO}`

const promptRevisar = (plano, unidade, impl, rodada) => `Você é um revisor de código independente. Você NÃO escreveu esta implementação e deve partir do pressuposto de que ela tem problemas até verificar o contrário. Sua aprovação libera o código para integração, então seja rigoroso. Esta é a rodada ${rodada} de revisão desta unidade.

${contextoUnidade(plano, unidade)}

O QUE O IMPLEMENTADOR DIZ TER FEITO: ${impl.summary}
ARQUIVOS QUE ELE DIZ TER ALTERADO:
${lista(impl.filesChanged)}
TESTES QUE ELE DIZ TER ADICIONADO:
${lista(impl.testsAdded)}
DECISÕES QUE ELE TOMOU:
${lista(impl.decisions)}
STATUS DECLARADO: ${impl.status}${impl.blockers && impl.blockers.length ? `\nBLOQUEIOS DECLARADOS:\n${lista(impl.blockers)}` : ''}

Como revisar:
- Veja as mudanças com \`git diff -- <arquivos>\` e \`git status\` (arquivos novos aparecem como untracked; leia-os inteiros). Não confie no resumo do implementador: confira no código.
- Leia também os pontos de uso (quem chama o código alterado) para detectar quebras.
- Para cada critério de aceite, verifique se está atendido. Registre os não atendidos em missingCriteria.
- Confira se os testes exercitam comportamento real e cobrem os edge cases. Rode os testes da unidade para confirmar que passam.
- Verifique convenções do projeto, tratamento de erros, segurança básica (validação de entrada, injeção, dados sensíveis em log) e se nada fora do escopo foi alterado.

Severidades: critical (bug, falha de segurança, critério de aceite não atendido), major (edge case sem cobertura, teste inadequado, quebra de convenção importante), minor (estilo, nomes, comentários).
verdict=approved SOMENTE se todos os critérios estão atendidos e não há findings critical ou major.
Não altere nenhum arquivo. Não faça commit.`

const promptCorrigir = (plano, unidade, impl, revisao, rodada) => `Você é o engenheiro responsável pela unidade ${unidade.id} · ${unidade.title}. Um revisor independente pediu mudanças (rodada ${rodada}). Corrija o que foi apontado e nada além disso.

${contextoUnidade(plano, unidade)}

ESTADO ATUAL SEGUNDO O IMPLEMENTADOR ANTERIOR: ${impl.summary}
ARQUIVOS JÁ ALTERADOS:
${lista(impl.filesChanged)}

FINDINGS DO REVISOR:
${lista((revisao.findings || []).map(f => `[${f.severity}] ${f.file ? f.file + ': ' : ''}${f.description}${f.suggestedFix ? ` → sugestão: ${f.suggestedFix}` : ''}`))}

CRITÉRIOS DE ACEITE NÃO ATENDIDOS:
${lista(revisao.missingCriteria)}
${revisao.notes ? `\nOBSERVAÇÕES DO REVISOR: ${revisao.notes}` : ''}

Se discordar de um finding, não o ignore em silêncio: explique em decisions por que não alterou.

${REGRAS_IMPLEMENTACAO}`

const promptIntegrar = (plano, resultadosOnda, numeroOnda) => `Você é o engenheiro de integração. A onda ${numeroOnda} de implementação acabou de terminar neste repositório: as unidades abaixo foram implementadas em paralelo por agentes diferentes e revisadas individualmente. Agora é a primeira vez que tudo roda junto.

CONTEXTO DA FEATURE: ${plano.specSummary}

UNIDADES DESTA ONDA:
${lista(resultadosOnda.map(r => `${r.unidade.id} · ${r.unidade.title} [${r.status}${r.aprovado ? ', aprovada pelo revisor' : ', NÃO aprovada pelo revisor'}] arquivos: ${(r.arquivos || []).join(', ') || '(não informados)'}`))}

COMANDO DA SUÍTE COMPLETA DE TESTES: ${plano.testCommand}
LINT / TYPECHECK: ${plano.lintCommand || 'descubra no projeto, se existir'}

Faça:
1. Rode a suíte completa de testes e, se existirem, lint e typecheck.
2. Se algo falhar, determine se a falha vem das mudanças desta onda (use \`git diff\` e \`git status\` para ver o que mudou). Corrija falhas causadas pela onda com o mínimo de alteração e sem mudar o comportamento pedido pela spec. Falhas pré-existentes e não relacionadas: registre em remainingProblems, não tente corrigir.
3. Rode tudo de novo até passar ou até esgotar as opções razoáveis.
Não faça commit. Não desabilite, apague ou enfraqueça testes para fazê-los passar.`

const promptAceite = (plano, resultados, integracoes, rodada) => `Você é o responsável pelo aceite final. Vários agentes implementaram uma spec em partes e um integrador confirmou o estado da suíte. Seu papel é diferente do deles: confrontar o RESULTADO COMPLETO com a SPEC ORIGINAL, requisito por requisito, como faria um PM exigente que vai apresentar essa feature. Esta é a rodada ${rodada} de aceite.

Releia a spec na fonte original:
${COMO_OBTER_SPEC}

RESUMO DO PLANO: ${plano.specSummary}

UNIDADES E ESTADO FINAL:
${lista(resultados.map(r => `${r.unidade.id} · ${r.unidade.title} [${r.status}${r.aprovado ? ', aprovada' : ', pendente de revisão humana'}]${r.decisoes && r.decisoes.length ? ` decisões: ${r.decisoes.join('; ')}` : ''}${r.bloqueios && r.bloqueios.length ? ` bloqueios: ${r.bloqueios.join('; ')}` : ''}`))}

PROBLEMAS PENDENTES DA INTEGRAÇÃO:
${lista(integracoes.flatMap(i => i.remainingProblems || []))}

PERGUNTAS EM ABERTO REGISTRADAS PELO PLANEJADOR:
${lista(plano.openQuestions)}

Faça:
1. Releia a spec na fonte. Liste cada requisito ou regra que ela impõe (funcional e não funcional).
2. Veja tudo que mudou: \`git status\` e \`git diff\`, mais os arquivos novos. Para cada requisito, encontre a evidência no código e nos testes.
3. Registre em requirementsMissing tudo que não foi implementado, foi implementado só parcialmente ou foi implementado de um jeito que muda o sentido do requisito. Para cada item, indique os arquivos que provavelmente precisam mudar e uma abordagem sugerida: um novo agente vai implementar a partir dessa descrição, então ela precisa ser autossuficiente.
4. Aponte regressões prováveis (comportamentos antigos que a mudança pode ter quebrado) em regressionsSuspected.
5. Escreva o campo report em markdown, em português, para um leitor não técnico: o que foi entregue, o que ficou de fora e por quê, decisões tomadas pelos agentes que merecem validação humana, perguntas em aberto e um roteiro curto de como testar manualmente.

complete=true SOMENTE se requirementsMissing estiver vazio. Não altere arquivos.`

const promptReportarLinear = (issueId, relatorio) => `Carregue as ferramentas do Linear via ToolSearch (mcp__Linear__get_issue e mcp__Linear__save_comment). Localize a issue ${issueId} e publique o relatório abaixo como um comentário nela. Não altere status, responsável, estimativa ou qualquer outro campo da issue. Se a issue não existir ou o Linear não estiver disponível, retorne explicando o que aconteceu.

RELATÓRIO A PUBLICAR:
${relatorio}`

const promptCommit = (plano, resultados) => `Crie um único commit com as mudanças pendentes deste repositório. Antes, rode \`git status\` e confira que não há arquivos temporários, segredos, dumps ou artefatos de build sendo adicionados; se houver, deixe-os de fora. Mensagem: primeira linha curta descrevendo a feature (${plano.specSummary.slice(0, 200)}), corpo listando as unidades implementadas:
${lista(resultados.map(r => `${r.unidade.id} · ${r.unidade.title}`))}
Não faça push. Retorne o hash do commit e a mensagem usada.`

// ---------------------------------------------------------------------------
// Lógica determinística (roda no script, não em agentes)
// ---------------------------------------------------------------------------

// Agrupa as unidades em ondas: uma unidade só entra numa onda quando todas as
// suas dependências já ficaram prontas em ondas anteriores, e duas unidades que
// tocam o mesmo arquivo nunca ficam na mesma onda.
function montarOndas(unidades) {
  const ids = new Set(unidades.map(u => u.id))
  const prontas = new Set()
  const ondas = []
  let restantes = unidades.slice()

  while (restantes.length) {
    const candidatas = restantes.filter(u =>
      (u.dependsOn || []).every(d => prontas.has(d) || !ids.has(d)))

    if (!candidatas.length) {
      log(`Dependência circular entre ${restantes.map(u => u.id).join(', ')}; essas unidades vão rodar em sequência.`)
      for (const u of restantes) ondas.push([u])
      break
    }

    const onda = []
    const arquivosUsados = new Set()
    for (const u of candidatas) {
      const arquivos = u.files || []
      if (arquivos.some(f => arquivosUsados.has(f))) continue // colide com alguém desta onda; fica para a próxima
      arquivos.forEach(f => arquivosUsados.add(f))
      onda.push(u)
    }

    ondas.push(onda)
    onda.forEach(u => prontas.add(u.id))
    restantes = restantes.filter(u => !prontas.has(u.id))
  }
  return ondas
}

const resumoResultado = (r) => `${r.unidade.id}: ${r.resumo || '(sem resumo)'}`

// Implementa uma unidade e a leva por rodadas de revisão e correção.
async function processarUnidade(plano, unidade, concluidas) {
  const dependenciasProntas = (unidade.dependsOn || [])
    .map(id => concluidas.get(id))
    .filter(Boolean)
    .map(resumoResultado)

  let impl = await agent(promptImplementar(plano, unidade, dependenciasProntas), {
    label: `implementar:${unidade.id}`,
    phase: 'Implementar',
    schema: IMPL_SCHEMA,
  })

  if (!impl) {
    return { unidade, status: 'skipped', aprovado: false, rodadas: 0, revisoes: [], arquivos: [], decisoes: [], bloqueios: ['agente de implementação não retornou'] }
  }

  const revisoes = []
  let ultimaRevisao = null

  if (impl.status !== 'blocked') {
    for (let rodada = 1; rodada <= RODADAS_REVISAO; rodada++) {
      ultimaRevisao = await agent(promptRevisar(plano, unidade, impl, rodada), {
        label: `revisar:${unidade.id}#${rodada}`,
        phase: 'Revisar',
        schema: REVISAO_SCHEMA,
        effort: 'high',
      })
      if (!ultimaRevisao) break
      revisoes.push(ultimaRevisao)
      if (ultimaRevisao.verdict === 'approved') break
      if (rodada === RODADAS_REVISAO) break // esgotou as rodadas; fica sinalizada para revisão humana

      const corrigida = await agent(promptCorrigir(plano, unidade, impl, ultimaRevisao, rodada), {
        label: `corrigir:${unidade.id}#${rodada}`,
        phase: 'Implementar',
        schema: IMPL_SCHEMA,
      })
      if (corrigida) impl = corrigida
    }
  }

  const aprovado = !!ultimaRevisao && ultimaRevisao.verdict === 'approved'
  const pendencias = ultimaRevisao && !aprovado
    ? (ultimaRevisao.findings || []).filter(f => f.severity !== 'minor').map(f => `[${f.severity}] ${f.description}`)
    : []

  return {
    unidade,
    status: impl.status,
    resumo: impl.summary,
    aprovado,
    rodadas: revisoes.length,
    revisoes,
    arquivos: impl.filesChanged || [],
    testes: impl.testsAdded || [],
    testesPassando: impl.testsPassing,
    decisoes: impl.decisions || [],
    bloqueios: impl.blockers || [],
    pendenciasDoRevisor: pendencias,
  }
}

// Roda um conjunto de unidades em ondas. Dentro da onda, as unidades vão em
// paralelo (arquivos disjuntos); entre ondas há uma barreira proposital, porque
// a onda seguinte depende do código da anterior e a integração precisa ver a
// onda inteira de uma vez.
async function executarUnidades(plano, unidades, concluidas, integracoes, rotulo) {
  const ondas = montarOndas(unidades)
  log(`${rotulo}: ${unidades.length} unidade(s) em ${ondas.length} onda(s): ${ondas.map(o => o.map(u => u.id).join('+')).join(' → ')}`)

  const resultados = []
  for (let i = 0; i < ondas.length; i++) {
    const onda = ondas[i]
    log(`Onda ${i + 1}/${ondas.length}: ${onda.map(u => u.title).join(' | ')}`)

    const daOnda = (await parallel(onda.map(u => () => processarUnidade(plano, u, concluidas)))).filter(Boolean)
    daOnda.forEach(r => concluidas.set(r.unidade.id, r))
    resultados.push(...daOnda)

    const aprovadas = daOnda.filter(r => r.aprovado).length
    log(`Onda ${i + 1}: ${aprovadas}/${daOnda.length} unidade(s) aprovadas pelo revisor. Integrando.`)

    const integracao = await agent(promptIntegrar(plano, daOnda, i + 1), {
      label: `integrar:onda-${i + 1}`,
      phase: 'Integrar',
      schema: INTEGRACAO_SCHEMA,
    })
    if (integracao) {
      integracoes.push({ onda: i + 1, ...integracao })
      if (!integracao.testsPassing) log(`Onda ${i + 1}: a suíte completa ainda tem falhas: ${(integracao.remainingProblems || []).join('; ') || 'ver resumo da integração'}`)
    } else {
      integracoes.push({ onda: i + 1, testsPassing: false, lintPassing: false, fixesApplied: [], remainingProblems: ['agente de integração não retornou'], summary: '' })
    }
  }
  return resultados
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

phase('Entender')
log(`Lendo a spec "${SPEC}" e a base de código.`)
let plano = await agent(promptPlanejador(), { label: 'planejar', phase: 'Entender', schema: PLANO_SCHEMA, effort: 'high' })

if (!plano) throw new Error('O agente planejador não retornou um plano.')
if (!plano.specFound) {
  return { spec: SPEC, status: 'spec_nao_encontrada', detalhe: plano.specSummary, perguntasEmAberto: plano.openQuestions || [] }
}
if (!plano.units || !plano.units.length) {
  return { spec: SPEC, status: 'sem_unidades', resumo: plano.specSummary, perguntasEmAberto: plano.openQuestions || [] }
}

phase('Criticar plano')
log(`Plano inicial com ${plano.units.length} unidade(s). Submetendo a um crítico independente.`)
const critica = await agent(promptCritico(plano), { label: 'criticar-plano', phase: 'Criticar plano', schema: CRITICA_SCHEMA, effort: 'high' })

if (critica && !critica.approved) {
  log(`Crítico pediu ajustes (${critica.coverageGaps.length} lacuna(s) de cobertura, ${critica.conflicts.length} conflito(s)). Replanejando.`)
  const revisado = await agent(promptReplanejar(plano, critica), { label: 'replanejar', phase: 'Criticar plano', schema: PLANO_SCHEMA, effort: 'high' })
  if (revisado && revisado.specFound && revisado.units && revisado.units.length) plano = revisado
  else log('Replanejamento falhou; seguindo com o plano original.')
} else if (critica) {
  log('Crítico aprovou o plano.')
} else {
  log('Crítico não retornou; seguindo com o plano original.')
}

const concluidas = new Map()
const integracoes = []
const resultados = await executarUnidades(plano, plano.units, concluidas, integracoes, 'Implementação')

phase('Aceitar')
let aceite = null
for (let rodada = 1; rodada <= RODADAS_ACEITE + 1; rodada++) {
  log(`Aceite (rodada ${rodada}): confrontando o resultado com a spec original.`)
  aceite = await agent(promptAceite(plano, resultados, integracoes, rodada), {
    label: `aceitar#${rodada}`,
    phase: 'Aceitar',
    schema: ACEITE_SCHEMA,
    effort: 'high',
  })
  if (!aceite) { log('Agente de aceite não retornou.'); break }
  if (aceite.complete) { log('Aceite: todos os requisitos da spec foram encontrados no código.'); break }

  const faltando = aceite.requirementsMissing || []
  log(`Aceite: ${faltando.length} requisito(s) faltando ou incompleto(s).`)
  if (rodada > RODADAS_ACEITE || !faltando.length) break

  const complementares = faltando.map((m, i) => ({
    id: `G${rodada}.${i + 1}`,
    title: m.requirement,
    description: `Requisito da spec que ficou faltando ou incompleto na implementação anterior.\nPor quê: ${m.why}\nAbordagem sugerida: ${m.suggestedApproach}`,
    files: m.files || [],
    dependsOn: [],
    acceptanceCriteria: [m.requirement],
    edgeCases: [],
    testsToWrite: [],
  }))
  const extras = await executarUnidades(plano, complementares, concluidas, integracoes, `Complemento do aceite ${rodada}`)
  resultados.push(...extras)
}

phase('Reportar')
const relatorio = aceite ? aceite.report : 'O agente de aceite não produziu relatório.'

let linear = null
if (REPORTAR_LINEAR && plano.source === 'linear') {
  const issueId = plano.linearIssueId || SPEC
  log(`Publicando o relatório como comentário na issue ${issueId}.`)
  linear = await agent(promptReportarLinear(issueId, relatorio), { label: `linear:${issueId}`, phase: 'Reportar', effort: 'low' })
}

let commit = null
if (FAZER_COMMIT) {
  log('Criando commit com as mudanças.')
  commit = await agent(promptCommit(plano, resultados), { label: 'commit', phase: 'Reportar', effort: 'low' })
}

const naoAprovadas = resultados.filter(r => !r.aprovado)
if (naoAprovadas.length) log(`${naoAprovadas.length} unidade(s) ficaram pendentes de revisão humana: ${naoAprovadas.map(r => r.unidade.id).join(', ')}`)

return {
  spec: SPEC,
  fonte: plano.source,
  resumo: plano.specSummary,
  unidades: resultados.map(r => ({
    id: r.unidade.id,
    titulo: r.unidade.title,
    status: r.status,
    aprovadoPeloRevisor: r.aprovado,
    rodadasDeRevisao: r.rodadas,
    arquivos: r.arquivos,
    testes: r.testes,
    decisoes: r.decisoes,
    bloqueios: r.bloqueios,
    pendenciasDoRevisor: r.pendenciasDoRevisor,
  })),
  integracao: integracoes,
  aceite: aceite ? {
    completo: aceite.complete,
    requisitosAtendidos: aceite.requirementsMet,
    requisitosFaltando: aceite.requirementsMissing,
    regressoesSuspeitas: aceite.regressionsSuspected,
  } : null,
  perguntasEmAberto: plano.openQuestions || [],
  relatorio,
  linear,
  commit,
}

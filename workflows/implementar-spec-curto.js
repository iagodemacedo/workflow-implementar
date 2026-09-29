// Workflow: implementar-spec-curto
// Versão curta do implementar-spec: 4 a 6 agentes em vez de 15 a 25.
// Uso: /implementar-spec-curto MAR-12
//      /implementar-spec-curto docs/PRD.md#checkout
// Opções (em linguagem natural ou como objeto em args):
//   raiz:             caminho absoluto de um git worktree para isolar a execução (padrão: o repositório atual)
//   base:             branch contra a qual o revisor compara o diff (padrão main)
//   listaSensivel:    pontos que o implementador confere e o revisor reconfere (padrão: lista genérica abaixo)
//   suiteCompleta:    o integrador roda a suíte inteira em vez de só os testes tocados (padrão false)
//   reportarNoLinear: publicar o relatório como comentário na issue (padrão true, só para specs do Linear)
//
// Agentes, no máximo 6:
//   1. planejar      um agente; no máximo 2 fatias
//   2. implementar   1 ou 2 agentes (2 só com arquivos disjuntos e sem dependência)
//   3. integrar      lint e testes dos arquivos tocados, corrige, faz o commit
//   4. revisar       o único revisor independente: spec mais lista sensível
//   5. corrigir      só se o revisor achou falta: um agente para todas as faltas, prova curta, commit
// O último agente a rodar publica o comentário no Linear. Com suiteCompleta=false, a suíte
// inteira fica para quem faz o merge (CI ou você).

export const meta = {
  name: 'implementar-spec-curto',
  description: 'Implementa uma spec com 4 a 6 agentes: planejar, implementar, integrar, revisar e corrigir',
  whenToUse: 'Spec pronta (issue do Linear, trecho de PRD ou texto) quando o custo do implementar-spec completo não compensa; a suíte inteira roda no merge ou com suiteCompleta',
  phases: [
    { title: 'Planejar', detail: 'ler a spec e dividir em no máximo 2 fatias' },
    { title: 'Implementar', detail: '1 ou 2 agentes, com autochecagem da lista sensível' },
    { title: 'Integrar', detail: 'lint e testes dos arquivos tocados, commit' },
    { title: 'Revisar', detail: 'revisor independente único contra a spec e a lista sensível' },
    { title: 'Corrigir', detail: 'um agente para todas as faltas, só se houver' },
  ],
}

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

const cfg = typeof args === 'string' ? { spec: args } : (args && typeof args === 'object' ? args : {})
if (!cfg.spec || typeof cfg.spec !== 'string') throw new Error('Informe a spec: identificador do Linear (ex.: MAR-12), caminho de arquivo (ex.: docs/PRD.md#secao) ou texto.')

const SPEC = cfg.spec.trim()
const RAIZ = typeof cfg.raiz === 'string' ? cfg.raiz.trim() : ''
const BASE = typeof cfg.base === 'string' && cfg.base.trim() ? cfg.base.trim() : 'main'
const SUITE_COMPLETA = cfg.suiteCompleta === true
const REPORTAR_LINEAR = cfg.reportarNoLinear !== false
const GIT = RAIZ ? `git -C ${RAIZ}` : 'git'

const lista = (arr) => (Array.isArray(arr) && arr.length) ? arr.map(x => `- ${x}`).join('\n') : '- (nenhum)'

const ISOLAMENTO = RAIZ
  ? `ISOLAMENTO, VALE ACIMA DE TUDO: o repositório desta execução é o git worktree ${RAIZ}. Todo arquivo que você ler, criar ou alterar fica dentro de ${RAIZ}, por caminho absoluto, e todo comando de shell começa com \`cd ${RAIZ} && \`. Não toque em outros checkouts do mesmo repositório.\n\n`
  : ''

const PREAMBULO = `${ISOLAMENTO}LEITURA DIRIGIDA: não leia documentos longos inteiros (PRD, arquitetura, rotas); ache a seção citada pelo título (\`grep -n '^## '\`) e leia só ela. Para ver o que mudou, use \`git diff\` e \`git status\`.

TESTES: rode só os testes ligados aos arquivos que você tocou. ${SUITE_COMPLETA ? 'A suíte inteira roda uma vez, no integrador.' : 'A suíte inteira não roda neste workflow: fica para o merge.'} Teste pulado não conta como prova. Siga as instruções do projeto (CLAUDE.md, AGENTS.md, README) sobre como rodar testes e lint.

`

// Pontos que o implementador confere antes de entregar e o revisor reconfere depois.
// Troque por args.listaSensivel com as regras que não podem quebrar no seu projeto.
const LISTA_SENSIVEL = typeof cfg.listaSensivel === 'string' && cfg.listaSensivel.trim()
  ? cfg.listaSensivel.trim()
  : `(a) segredo, token ou dado pessoal gravado em log, resposta de erro ou lugar indevido;
(b) validação de entrada e autorização em toda rota, ação ou ferramenta nova;
(c) edge case citado na spec sem teste que o exercite;
(d) comportamento existente quebrado ou alterado sem a spec pedir;
(e) mudança fora do escopo da spec.`

const COMO_OBTER_SPEC = `Como obter a spec "${SPEC}": se for identificador do Linear, carregue via ToolSearch a ferramenta get_issue do Linear e leia a issue inteira, com comentários; leia só as seções dos documentos do repositório que ela citar. Se for caminho de arquivo, leia o arquivo (a parte após # é a seção). Senão, o texto é a própria spec.`

const ag = (prompt, opts) => agent(PREAMBULO + prompt, opts)

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const FATIA_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string', description: 'Autossuficiente: regras, números e edge cases exatos copiados da spec' },
    files: { type: 'array', items: { type: 'string' } },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    edgeCases: { type: 'array', items: { type: 'string' } },
    testsToWrite: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'title', 'description', 'files', 'acceptanceCriteria'],
}

const PLANO_SCHEMA = {
  type: 'object',
  properties: {
    specFound: { type: 'boolean' },
    source: { type: 'string', enum: ['linear', 'file', 'inline', 'unknown'] },
    linearIssueId: { type: 'string' },
    specSummary: { type: 'string', description: 'Resumo fiel da spec, em português, com todos os requisitos e regras' },
    stack: { type: 'string' },
    testCommand: { type: 'string', description: 'Como rodar um arquivo de teste e a suíte inteira neste projeto' },
    lintCommand: { type: 'string', description: 'Comando de lint e typecheck, se existir' },
    openQuestions: { type: 'array', items: { type: 'string' } },
    paralelo: { type: 'boolean', description: 'true só se houver 2 fatias com arquivos disjuntos e nenhuma depender da outra' },
    units: { type: 'array', items: FATIA_SCHEMA, maxItems: 2 },
  },
  required: ['specFound', 'source', 'specSummary', 'stack', 'testCommand', 'openQuestions', 'paralelo', 'units'],
}

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'array', items: { type: 'string' } },
    testsPassing: { type: 'boolean' },
    autochecagem: { type: 'string', description: 'Resultado da conferência dos pontos (a) a (g), um por linha' },
    decisions: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary', 'filesChanged', 'testsAdded', 'testsPassing', 'decisions', 'blockers'],
}

const INTEGRACAO_SCHEMA = {
  type: 'object',
  properties: {
    lintPassing: { type: 'boolean' },
    testsPassing: { type: 'boolean' },
    testsRun: { type: 'string', description: 'Quais arquivos de teste rodaram e o placar' },
    fixesApplied: { type: 'array', items: { type: 'string' } },
    remainingProblems: { type: 'array', items: { type: 'string' } },
    commit: { type: 'string', description: 'Hash do commit criado, ou vazio' },
  },
  required: ['lintPassing', 'testsPassing', 'testsRun', 'fixesApplied', 'remainingProblems', 'commit'],
}

const REVISAO_SCHEMA = {
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
          why: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          suggestedApproach: { type: 'string' },
        },
        required: ['requirement', 'why', 'files', 'suggestedApproach'],
      },
    },
    regressionsSuspected: { type: 'array', items: { type: 'string' } },
    report: { type: 'string', description: 'Relatório em markdown, em português, para leitor não técnico' },
    linear: { type: 'string', description: 'Resultado da publicação no Linear, ou "não publicado"' },
  },
  required: ['complete', 'requirementsMet', 'requirementsMissing', 'regressionsSuspected', 'report'],
}

const CORRECAO_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'string' } },
    notFixed: { type: 'array', items: { type: 'string' }, description: 'Faltas não corrigidas, com o porquê' },
    lintPassing: { type: 'boolean' },
    testsPassing: { type: 'boolean' },
    testsRun: { type: 'string' },
    commit: { type: 'string' },
    linear: { type: 'string' },
  },
  required: ['fixed', 'notFixed', 'lintPassing', 'testsPassing', 'testsRun', 'commit'],
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const promptPlanejar = () => `Você é o planejador técnico. ${COMO_OBTER_SPEC} Se não achar a spec, retorne specFound=false e explique em specSummary.

Entenda a base de código só o suficiente para planejar (estrutura, convenções, onde ficam os testes) e descubra os comandos de teste e de lint (package.json, Makefile, pyproject, CLAUDE.md, AGENTS.md, README).

Regras do plano:
- No máximo 2 fatias; prefira 1. Cada fatia é vertical (dado, lógica, testes e a documentação viva que ela exige juntos), nunca uma camada. Nada de fatia só de documentos, tipos, configuração ou testes.
- Duas fatias só quando os arquivos forem disjuntos e nenhuma depender da outra; nesse caso paralelo=true. Se uma depende da outra, paralelo=false e a ordem das fatias é a ordem de execução.
- A descrição de cada fatia é autossuficiente: copie as regras, números, textos e edge cases exatos da spec e cite as seções dos documentos pelo título. O implementador não vai ler a issue.
- Critérios de aceite verificáveis e os testes a escrever, incluindo um para cada edge case da spec.
- Nada fora do escopo. Onde a spec for omissa, escolha a opção mais conservadora e registre em openQuestions.
- Não altere arquivos.`

const promptImplementar = (plano, fatia, anterior) => `Você é o engenheiro de UMA fatia de uma issue.${plano.paralelo ? ' Outro agente implementa a outra fatia ao mesmo tempo neste repositório; fique estritamente nos seus arquivos.' : ''}

CONTEXTO DA ISSUE: ${plano.specSummary}
STACK E CONVENÇÕES: ${plano.stack}
TESTES: ${plano.testCommand}
LINT: ${plano.lintCommand || 'descubra no projeto, se existir'}
${anterior ? `FATIA ANTERIOR, JÁ PRONTA: ${anterior}\n` : ''}
FATIA ${fatia.id} · ${fatia.title}
${fatia.description}

ARQUIVOS:
${lista(fatia.files)}
CRITÉRIOS DE ACEITE:
${lista(fatia.acceptanceCriteria)}
EDGE CASES:
${lista(fatia.edgeCases)}
TESTES A ESCREVER:
${lista(fatia.testsToWrite)}

Regras:
1. Leia o código vizinho antes e siga as convenções. Nada de dependência nova sem necessidade real.
2. Testes de comportamento real, com o banco real quando tocar banco.
3. Rode os testes dos seus arquivos e o lint até passarem.
4. Antes de entregar, confira você mesmo esta lista e registre o resultado em autochecagem, um ponto por linha. Um revisor independente vai conferir a mesma lista depois:
${LISTA_SENSIVEL}
5. Sem commit, sem trocar de branch, sem git stash.
6. Decisão que a spec não cobre: a opção mais conservadora, registrada em decisions. Não pare para perguntar.
7. Se algo impedir a conclusão, status=blocked com blockers claros.`

const promptIntegrar = (plano, impls) => `Você é o integrador. As fatias abaixo acabaram de ser implementadas neste repositório.

CONTEXTO DA ISSUE: ${plano.specSummary}
FATIAS:
${lista(impls.map(r => `${r.fatia.id} · ${r.fatia.title} [${r.impl ? r.impl.status : 'sem retorno'}] arquivos: ${r.impl ? (r.impl.filesChanged || []).join(', ') : ''}`))}

Faça:
1. Lint e typecheck: ${plano.lintCommand || 'descubra no projeto, se existir'}.
2. ${SUITE_COMPLETA ? `A suíte inteira: ${plano.testCommand}.` : `Os testes ligados aos arquivos alterados: descubra pelo \`git status\` e \`git diff --name-only\` quais arquivos de teste cobrem o que mudou, incluindo testes antigos de módulos tocados. Como rodar: ${plano.testCommand}. NÃO rode a suíte inteira: ela fica para o merge.`}
3. Corrija falhas causadas por estas fatias com o mínimo de alteração, sem mudar o comportamento pedido. Nunca desabilite, apague ou enfraqueça teste.
4. Com lint e testes passando, faça um commit: confira no \`git status\` que não entram temporários, segredos, dumps ou artefatos de build; \`${GIT} add -A && ${GIT} commit -m "${SPEC}: <resumo curto>"\`. Se não passar, faça o commit mesmo assim com a mensagem começando por "WIP" e registre os problemas em remainingProblems. Retorne o hash.`

const promptRevisar = (plano, impls, integ) => `Você é o ÚNICO revisor independente desta issue. Você não escreveu nada e parte do pressuposto de que há problemas até verificar o contrário. Seu papel é confrontar o resultado com a spec original, requisito por requisito, como um PM exigente.

${COMO_OBTER_SPEC}

RESUMO DO PLANO: ${plano.specSummary}
DECISÕES DOS IMPLEMENTADORES:
${lista(impls.flatMap(r => (r.impl && r.impl.decisions) || []))}
AUTOCHECAGEM DOS IMPLEMENTADORES (não confie, confira):
${lista(impls.map(r => r.impl && r.impl.autochecagem ? `${r.fatia.id}: ${r.impl.autochecagem}` : `${r.fatia.id}: não informada`))}
INTEGRAÇÃO: lint ${integ && integ.lintPassing ? 'ok' : 'com falha'}, testes ${integ && integ.testsPassing ? 'ok' : 'com falha'}; pendências:
${lista(integ ? integ.remainingProblems : ['integrador não retornou'])}

Faça:
1. Veja o que mudou com \`${GIT} diff ${BASE}...HEAD\` e \`${GIT} status\`.
2. Para cada requisito da spec, ache a evidência no código e no teste. Rode os testes relacionados ao que for afirmar (${plano.testCommand}); não rode a suíte inteira.
3. Confira no diff, com ceticismo, a lista fixa:
${LISTA_SENSIVEL}
4. Registre em requirementsMissing tudo que falta, está parcial, muda o sentido do requisito ou viola a lista. Cada item precisa ser autossuficiente: um corretor vai trabalhar só com ele.
5. Escreva report em markdown, em português, para leitor não técnico: o que foi entregue, o que ficou de fora e por quê, decisões que merecem validação do dono, perguntas em aberto e um roteiro curto de teste manual.
${REPORTAR_LINEAR && plano.source === 'linear' ? `6. SÓ SE complete=true: carregue via ToolSearch a ferramenta save_comment do Linear e publique report como comentário na issue ${plano.linearIssueId || SPEC}, sem mudar nenhum campo da issue. Informe o resultado em linear. Se complete=false, não publique (o corretor publica).` : ''}

complete=true SOMENTE se requirementsMissing estiver vazio. Não altere arquivos.`

const promptCorrigir = (plano, rev) => `Você é o corretor. O revisor independente apontou as faltas abaixo. Corrija TODAS, e nada além delas.

CONTEXTO DA ISSUE: ${plano.specSummary}

FALTAS:
${lista((rev.requirementsMissing || []).map(m => `${m.requirement}\n  Por quê: ${m.why}\n  Arquivos: ${(m.files || []).join(', ')}\n  Abordagem sugerida: ${m.suggestedApproach}`))}
REGRESSÕES SUSPEITAS (confira; corrija se forem reais):
${lista(rev.regressionsSuspected)}

Regras:
1. Cada falta corrigida ganha teste que a prove, quando fizer sentido.
2. Se discordar de uma falta, não a ignore em silêncio: registre em notFixed com o porquê.
3. Prova curta: lint e os testes dos arquivos tocados (${plano.testCommand}). Não rode a suíte inteira.
4. Commit: \`${GIT} add -A && ${GIT} commit -m "${SPEC}: correções da revisão"\`, depois de conferir que não entram temporários nem segredos.
${REPORTAR_LINEAR && plano.source === 'linear' ? `5. Por fim, carregue via ToolSearch a ferramenta save_comment do Linear e publique na issue ${plano.linearIssueId || SPEC} o relatório abaixo, acrescido de uma seção "Correções depois da revisão" com o que corrigiu e o que não corrigiu. Não mude nenhum campo da issue. Informe o resultado em linear.

RELATÓRIO DO REVISOR:
${rev.report}` : ''}`

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

phase('Planejar')
const plano = await ag(promptPlanejar(), { label: 'planejar', phase: 'Planejar', schema: PLANO_SCHEMA, effort: 'high' })
if (!plano) throw new Error('O planejador não retornou.')
if (!plano.specFound) return { spec: SPEC, status: 'spec_nao_encontrada', detalhe: plano.specSummary }
if (!plano.units || !plano.units.length) return { spec: SPEC, status: 'sem_fatias', resumo: plano.specSummary, perguntasEmAberto: plano.openQuestions || [] }

// Garantia no script: mais de 2 fatias vira 2 (as excedentes entram na segunda, em sequência).
let fatias = plano.units
if (fatias.length > 2) {
  const [a, ...resto] = fatias
  fatias = [a, {
    id: resto.map(f => f.id).join('+'),
    title: resto.map(f => f.title).join(' e '),
    description: resto.map(f => `${f.title}:\n${f.description}`).join('\n\n'),
    files: resto.flatMap(f => f.files || []),
    acceptanceCriteria: resto.flatMap(f => f.acceptanceCriteria || []),
    edgeCases: resto.flatMap(f => f.edgeCases || []),
    testsToWrite: resto.flatMap(f => f.testsToWrite || []),
  }]
  plano.paralelo = false
}
const disjuntas = fatias.length === 2 && !(fatias[0].files || []).some(f => (fatias[1].files || []).includes(f))
const paralelo = fatias.length === 2 && plano.paralelo === true && disjuntas
log(`Plano: ${fatias.length} fatia(s), ${paralelo ? 'em paralelo' : 'em sequência'}.`)

phase('Implementar')
const implementar = (fatia, anterior) => ag(promptImplementar({ ...plano, paralelo }, fatia, anterior), {
  label: `implementar:${fatia.id}`, phase: 'Implementar', schema: IMPL_SCHEMA,
}).then(impl => ({ fatia, impl }))

let impls
if (paralelo) {
  impls = (await parallel(fatias.map(f => () => implementar(f, null)))).filter(Boolean)
} else {
  impls = []
  for (const f of fatias) {
    const anterior = impls.length && impls[impls.length - 1].impl ? impls[impls.length - 1].impl.summary : null
    impls.push(await implementar(f, anterior))
  }
}
const bloqueadas = impls.filter(r => !r.impl || r.impl.status === 'blocked')
if (bloqueadas.length) log(`Fatias bloqueadas ou sem retorno: ${bloqueadas.map(r => r.fatia.id).join(', ')}`)

phase('Integrar')
const integ = await ag(promptIntegrar(plano, impls), { label: 'integrar', phase: 'Integrar', schema: INTEGRACAO_SCHEMA })
if (!integ) log('O integrador não retornou.')
else log(`Integração: lint ${integ.lintPassing ? 'ok' : 'falhou'}, testes ${integ.testsPassing ? 'ok' : 'falharam'}, commit ${integ.commit || 'nenhum'}.`)

phase('Revisar')
const rev = await ag(promptRevisar(plano, impls, integ), { label: 'revisar', phase: 'Revisar', schema: REVISAO_SCHEMA, effort: 'high' })
if (!rev) log('O revisor não retornou.')
else log(rev.complete ? 'Revisão: nada faltando.' : `Revisão: ${(rev.requirementsMissing || []).length} falta(s).`)

let corr = null
if (rev && !rev.complete && (rev.requirementsMissing || []).length) {
  phase('Corrigir')
  corr = await ag(promptCorrigir(plano, rev), { label: 'corrigir', phase: 'Corrigir', schema: CORRECAO_SCHEMA })
  if (corr) log(`Correção: ${corr.fixed.length} corrigida(s), ${corr.notFixed.length} não, commit ${corr.commit || 'nenhum'}.`)
  else log('O corretor não retornou.')
}

return {
  spec: SPEC,
  resumo: plano.specSummary,
  fatias: impls.map(r => ({
    id: r.fatia.id,
    titulo: r.fatia.title,
    status: r.impl ? r.impl.status : 'sem retorno',
    arquivos: r.impl ? r.impl.filesChanged : [],
    decisoes: r.impl ? r.impl.decisions : [],
    bloqueios: r.impl ? r.impl.blockers : [],
  })),
  integracao: integ,
  revisao: rev ? {
    completo: rev.complete,
    faltando: rev.requirementsMissing,
    regressoesSuspeitas: rev.regressionsSuspected,
    linear: rev.linear || null,
  } : null,
  correcao: corr,
  perguntasEmAberto: plano.openQuestions || [],
  relatorio: rev ? rev.report : 'O revisor não produziu relatório.',
  pendenteParaOMerge: SUITE_COMPLETA ? 'Nada além da revisão humana.' : 'Rodar a suíte inteira antes do merge.',
}

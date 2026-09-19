# Avaliação do NextCode

**Para:** Gabriel (owner)  
**Data:** 2026-09-19  
**Base:** `dev` em `6d9976846` (`ci(shell): vendor the llama-server runtime before the shell build`)  
**Repositório:** https://github.com/stoltembergg-png/nextcode  

Leitura apenas. Nenhum código de runtime foi alterado. Isto não é um audit formal de segurança nem uma revisão linha a linha do motor herdado — é um julgamento do estado do *fork de produto* que você está construindo.

---

## 1. O que o projeto é

NextCode é um **agente de programação com IA no desktop** (Windows x64 + macOS Apple Silicon). A descrição do GitHub é honesta: *"nextcode desktop migration (Electron → Tauri v2) working fork"*. O repo foi criado em 2026-09-17; em dois dias já há releases de `v0.0.1` até `v0.0.7-beta.2`.

O produto é um **shell nativo em volta de um motor herdado**. A linhagem é o OpenCode (`anomalyco` / `sst/opencode`): sessões, agentes, ferramentas, PTY, MCP, providers. O NextCode não reescreveu esse motor. O que é *deste* fork:

- o shell Tauri 2 em `packages/desktop/src-tauri/`
- o pipeline de release em `.github/workflows/tauri-release.yml`
- o plugin SemIf (`plugins/semif/`, `specs/semif-plugin.md`) — decisões semânticas locais via `llama-server`
- a identidade visual em `packages/identity/`
- os documentos de direção em `specs/tauri-migration.md`, `specs/stack-evolution.md`, `specs/performance-audit.md`

### Stack

| Camada | Tecnologia | Onde |
| --- | --- | --- |
| Shell | Tauri 2 (Rust 2021), plugins `shell`, `single-instance`, `deep-link`, `dialog`, `opener`, `process`, `updater`, `log`, `decorum` (Windows) | `packages/desktop/src-tauri/` |
| Renderer | SolidJS + Vite (`vite.tauri.config.ts`) | `packages/app`, `packages/ui`, `packages/session-ui` |
| Ponte | `window.api` — Electron preload **ou** shim Tauri | `src/preload/index.ts` vs `src/renderer/tauri-api.ts` |
| Motor | Bun `--compile` sidecar (`bun@1.3.14`), loopback HTTP/WS | `packages/opencode` → `externalBin` `opencode-cli` |
| Domínio | Effect `4.0.0-beta.83`, Drizzle/SQLite, HttpApi + clientes gerados | `packages/core`, `packages/server`, `packages/schema`, `packages/protocol`, `packages/client` |
| SemIf | plugin + `llama-server` vendido no bundle | `plugins/semif/`, `src-tauri/semif/` |

Monorepo Bun + Turbo. `package.json` raiz ainda se chama `"opencode"`. Pacotes npm continuam `@opencode-ai/*`. Isso é consciente (`specs/stack-evolution.md` item 10: só renomear se for publicar).

### Migração Electron → Tauri: status real

**O release já é Tauri.** Os instaladores em GitHub Releases vêm de `tauri-release.yml` (NSIS + dmg, feed `latest.json` assinado com minisign). Não há workflow Electron.

**O desenvolvimento local padrão ainda é Electron.** Em `packages/desktop/package.json`:

- `"dev"` / `"build"` / `"package*"` → `electron-vite` + `electron-builder`
- Tauri é `predev:tauri` + `bun run tauri dev`
- `src/main/` (~45 arquivos), `src/preload/`, `electron-builder.config.ts` e as deps Electron 42.3.3 continuam no tree

A spec (`specs/tauri-migration.md`) é explícita: P0–P4 do *shell* estão feitos; **ainda pendente** o ciclo real install→update→restart, hardening de sidecar órfão no macOS, e **a remoção do Electron**. O README raiz já fala só de Tauri; `packages/desktop/README.md` e `CONTRIBUTING.md` (linhas 76 e 126–138) ainda descrevem Electron. Quem clonar o repo e seguir o CONTRIBUTING sobe o shell errado.

Paridade incompleta no shim (`packages/desktop/src/renderer/tauri-api.ts`): `installCli` devolve `""`, `wslServers` é `undefined`, onboarding/layout-migration sempre `false`, `readClipboardImage` sempre `null`, `runDesktopMenuAction` e `setTitlebar` são no-op, `getPathForFile` devolve `""` (`dragDropEnabled: false` em `tauri.conf.json`). O comentário de cabeçalho do shim ainda diz que pickers/updater/menu são “fases posteriores” — isso já está desatualizado.

---

## 2. Saúde do repositório

### README

O `README.md` raiz é utilizável: o que é o produto, instaladores, caveat de unsigned, feed de update, como buildar, tabela de pastas. Problemas concretos:

- A seção License diz que “NextCode is based on NextCode” no mesmo URL — auto-referência, sem nomear o OpenCode / anomalyco.
- Não diz que Linux desktop foi cortado de propósito (só está em `specs/tauri-migration.md`).
- `CONTRIBUTING.md` pede Bun 1.3+; o README e o `packageManager` pinam `1.3.14`.

### Docs

Não havia pasta `docs/` até este arquivo. O que existe é *forte* e está em `specs/`:

| Documento | Valor |
| --- | --- |
| `specs/tauri-migration.md` (~760 linhas) | Porquê, comparação, fases, riscos, checklist de paridade |
| `specs/performance-audit.md` | Números medidos (RAM, sidecar, `opencode.db` 3,13 GB) |
| `specs/stack-evolution.md` | Snapshot + roadmap com itens riscados quando feitos |
| `specs/semif-plugin.md` | Spec em pt-BR com probes empíricos e hash do modelo |
| `CONTEXT.md` / `AGENTS.md` | Vocabulário de sessão e convenções (ainda falam “OpenCode”) |

`CONTRIBUTING.md` e `packages/desktop/README.md` estão **stale**. `SECURITY.md` foi rebatizado para NextCode, mas o escalation ainda é `security@anoma.ly`. `.github/CODEOWNERS` e `.github/TEAM_MEMBERS` ainda apontam `@Hona` e `@Brendonovich` (upstream). Templates de issue/PR são do OpenCode, inclusive a ameaça de fechar PR com descrição “claramente gerada por IA”.

### CI

Cinco workflows. **Nenhum dispara em `dev` nem em `pull_request`.** Quatro só em `push` para `tauri-shell`:

| Workflow | Trigger | O que faz |
| --- | --- | --- |
| `tauri-shell-windows.yml` | `tauri-shell` + paths | Sidecar cross-compile + smoke Windows (~40 s, asserts em log) |
| `tauri-shell-macos.yml` | `tauri-shell` + paths (sem `packages/opencode/**`) | Idem macOS |
| `app-tests.yml` | `tauri-shell` | typecheck app/ui/session-ui; `bun test` do **app com `continue-on-error: true`**; 1 spec Playwright de 63 |
| `codegen-check.yml` | `tauri-shell` | `bun run --cwd packages/client check:generated` |
| `tauri-release.yml` | tag `v*` / `workflow_dispatch` | Sidecar + mirror llama.cpp + NSIS/dmg + minisign |

`app-tests.yml` usa Bun **1.4.2** de propósito (Solid/ICU); sidecar/release usam **1.3.14**. Dois mundos Bun, documentado no próprio workflow.

Consequência: um merge em `dev` (a default branch) **não typechecka, não linta, não testa o motor, não fuma o shell**. O husky `pre-push` roda `bun typecheck` na máquina de quem der push — só isso.

### Testes

O corpus herdado é grande e de verdade: `packages/opencode` 256 testes, `core` 144, `app` 130 + 63 Playwright, mais `tui`/`llm`/`session-ui`. O root bloqueia `bun test` de propósito.

O que *este* produto não cobre:

- `packages/desktop/src-tauri/src/main.rs` (~1787 linhas) — zero `#[test]`
- 15 `.test.ts` em `packages/desktop/` sem script `"test"` e fora do CI
- motor (`opencode`/`core`/`llm`) nunca roda no GitHub Actions deste fork
- a spec de migração pede um *bridge contract test* (shim vs `ElectronAPI`) — não existe

### Dependências

Sinal bom: catálogo centralizado, Bun pinado, 19 patches com `packages/opencode/test/patched-dependencies.test.ts` (que não roda no CI). Sinal de risco: Effect e Drizzle em beta/RC; `electron` ainda em `trustedDependencies`; TypeScript 5.8 no catálogo vs `~5.6.2` no desktop.

### Segredos

Nada de `.env` commitado, nada de chave privada no tree. A pubkey minisign em `tauri.conf.json:42` é o esperado para o updater. Workflows só referenciam `${{ secrets.* }}`. `.gitignore` cobre `.env` / `.env.local`, mas não `*.pem`, `*.p12` nem material minisign local. Testes usam placeholders (`AKIAIOSFODNN7EXAMPLE`).

### License

MIT. `LICENSE` diz `Copyright (c) 2025 opencode`. O GitHub marca o repo como `fork: false` — é uma cópia de trabalho, não um fork oficial. A atribuição ao projeto de origem está incompleta e o README se cita a si mesmo. Isso é o ponto legal mais frágil do repo hoje, não o texto da licença.

### Releases (sinal operacional)

Dez tags no dia 18/09, incluindo `v0.0.7-beta.1` publicado como **não-prerelease** e `v0.0.7-beta.2` como prerelease. `tauri.conf.json` ainda está em `0.0.6`; `Cargo.toml` em `0.0.0`. Identificador do bundle: `ai.opencode.desktop.v2.dev`. Endpoint do updater usa `.../NextCode/releases/...` (N maiúsculo) contra o repo `nextcode`. GitHub costuma ser case-insensitive no path, mas o identifier `.v2.dev` significa que dados e updates de “produção” ainda vivem no perfil de *dev*.

Zero issues abertas. Um PR aberto: [#1](https://github.com/stoltembergg-png/nextcode/pull/1) (`feat(opencode): wire native semif sidecar service and tools`).

---

## 3. Arquitetura — forças e riscos

### O que a arquitetura acerta

A UI **não conhece o shell**. `packages/app` passa por `Platform` (`packages/app/src/context/platform.tsx`), materializado em `packages/desktop/src/renderer/index.tsx` via `window.api`. Quase nenhum `window.api` vaza para `app`/`ui`/`session-ui` (exceção: `window.api?.setTitlebar?.()` em `packages/app/src/app.tsx`). Por isso a migração foi um *checklist*, não um rewrite.

O sidecar é o desenho certo para este produto: Bun `--compile` (~180 MB) em `bundle.externalBin`, spawn com `serve --hostname 127.0.0.1`, senha aleatória, health check. No Windows, Job Object mata o processo filho com o shell. SemIf entra pelo mesmo canal (`NEXTCODE_SEMIF_SERVER_PATH`), não por um segundo runtime Node.

A superfície de IPC é enumerável: ~54 handlers em `src/main/ipc.ts` + ~13 WSL; 32 commands Rust em `generate_handler!` (`main.rs` ~1666–1699). `open_external` / `open_local_file` copiam o allowlist de scheme de `src/main/external-url.ts` (`http`/`https`/`mailto`; `file:` sem host). Pickers usam token + path e teto de 20 MB.

O release é o pedaço mais “de produto” do fork: sidecar cross-compilado no Ubuntu (workaround do tree-sitter-powershell no Windows), mirror dos nightlies do llama.cpp antes que o upstream apague, signing opcional que degrada para unsigned, feed minisign merged.

### Riscos

**1. Dois shells, um produto.** Default `dev` = Electron; o que o usuário baixa = Tauri. Identifiers diferentes (`ai.opencode.desktop.dev` vs `ai.opencode.desktop.v2.dev`). Deep link `opencode://` nos dois. Sem import de dados no lado Tauri (só o caminho inverso em `src/main/migrate.ts`). Quem testar localmente e quem instala o `.exe` não estão no mesmo app.

**2. `main.rs` monolítico.** A spec pedia um módulo Rust por domínio (`store`, `drafts`, `pickers`, `menu`, `wsl`…). Hoje tudo está num arquivo de ~1787 linhas, sem testes. Drift entre shim e commands é silencioso — o contrato de `ElectronAPI` em `src/preload/types.ts` não é verificado contra o Tauri.

**3. Segurança do webview é frouxa de propósito, e um pouco mais frouxa que o Electron.**

| Ponto | Evidência | Nota |
| --- | --- | --- |
| CSP | `"csp": null` em `tauri.conf.json:24-26` | Qualquer XSS no renderer vira invoke de command |
| `withGlobalTauri: true` | `tauri.conf.json:10` | `__TAURI__` no window |
| Store | `store_file` faz `dir.join(name)` sem sanitizar (`main.rs:356-359`) | `name` com `..` sai do app data |
| `open_path` | `Command::new(app_name).args([path])` no Windows (`main.rs:682-698`) | Mesmo padrão do Electron `ipc.ts` |
| Menu `href` | `on_menu_event` abre URL **sem** o allowlist de `open_external` | Buraco novo do Tauri |
| Picker token | Electron amarra `event.sender.id`; Tauri só token+path | Menor numa janela só |
| Self-test debug | `reveal_path` com `D:\\Projetos\\JevCode\\package.json` (`main.rs:1600`) | Só `debug_assertions`, mas é artefato pessoal no tree |
| Devtools | feature `devtools` no crate Tauri em release | Paridade com Electron; superfície extra |

O `SECURITY.md` é claro e correto no threat model: o agente **não** é sandbox; permissão é UX. Isso não desculpa CSP nulo nem path traversal no store — são bugs de *shell*, não de “o modelo pode rodar `rm`”.

**4. Storage.** Medido em 2026-09-18: `opencode.db` 3,13 GB, tabela `event` 2,93 GB. Sem retenção temporal; `VACUUM` não roda sozinho. Higiene parcial já entrou (sweep de órfãos, `wal_checkpoint(TRUNCATE)`, Settings → Storage). A retenção que respeita `admitted_seq` / epoch ainda não. Sessões longas ficam mais lentas no replay mesmo com boot barato.

**5. Identidade de release.** Bundle ID `.v2.dev`, versão 0.0.6 no conf vs tags 0.0.7-beta, beta.1 marcado como release estável, installers sem code-sign de OS (o README avisa; o updater *é* assinado). Para um produto que você já está pedindo para pessoas instalarem, isso é o risco de confiança, não de arquitetura.

**6. SemIf no bundle.** Vendor do `llama-server` + modelo local é a aposta diferenciada do fork. O lock (`packages/opencode/script/semif-server.lock.json`) e o job `mirror` são o jeito certo. O risco é operacional: binário nativo extra, GPU/CPU no desktop do usuário, e o PR #1 ainda está abrindo o wiring nativo no motor.

---

## 4. Sinais de qualidade de código

### Consistência

Dois nomes em todo lugar: NextCode na UI (`productName`, título, i18n de produto) e OpenCode no resto (`@opencode-ai/*`, stores `opencode.settings`, scheme `opencode://`, username do sidecar `"opencode"`, `CONTEXT.md`). Isso é aceitável *internamente* se for decisão. Não é aceitável no LICENSE, no CODEOWNERS, no SECURITY de escalation e no identifier do instalador.

O default script do desktop e o README do pacote contradizem o README raiz. O header de `tauri-api.ts` contradiz o próprio arquivo.

### Error handling

Tauri engole falha com frequência: `getVersion().catch(() => undefined)`, listeners `.catch(() => log_stub)`, `recordFatalRendererError` só vai para `log_stub`. Electron grava fatal do renderer em arquivo (`src/main/index.ts`). Store Electron (`ipc.ts:114-122`) transforma corrupção em `null`. Menu nativo Tauri loga e segue. Nada disso quebra o boot; tudo isso dificulta diagnosticar o que o usuário vê.

O único pedaço *cuidado* nessa frente é `src/renderer/initialization.ts`: corta o prefixo feio do IPC Electron para a UI mostrar a falha real do sidecar.

### Código morto / dívida que importa

- Stack Electron inteiro, ainda default.
- Stubs do shim listados na §1 — não são TODO de comentário; são features que a UI acha que existem.
- TODOs reais em `packages/app`:
  - `context/global-sync/home-session-index.ts` — full-table scan porque a API v2 não filtra roots/archives
  - `context/global-sync/child-store.ts` — criação passiva de child no Home
  - `components/help-button.tsx` — `showPopover = () => true` (onboarding sempre elegível)
- `main.rs:1596-1604` — self-test temporário com path pessoal.
- Quase zero `TODO` em `packages/desktop/src` e `plugins/semif` — a dívida está em *ausência* (stubs, Electron), não em comentários.

`@ts-ignore` de produção: dois, ambos `use:sortable` em `sidebar-workspace.tsx` / `sidebar-project.tsx`. Baixo risco.

### SemIf e session-ui

`plugins/semif/` está limpo: `index.ts` / `engine.ts` / `scoring.ts` / `config.ts`, tools `semif_decide` + `semif_status`, spawn/adopt/dispose, testes próprios (`test.ts`, `smoke.ts`). A spec em pt-BR documenta invariantes de tokenizer que *foram medidas*. `packages/session-ui` não tem TODO de produção — só Storybook de a11y.

---

## 5. Top 5 prioridades (por impacto)

### 1. CI na branch default e em PR — esforço **M**

**Por quê.** `dev` é a default e está sem rede de proteção. O corpus de testes do motor (400+ arquivos) e o typecheck monorepo só existem se alguém lembrar de rodá-los. Os jobs úteis já estão escritos — estão apontando para `tauri-shell`. Ligar `dev` + `pull_request`, tirar `continue-on-error` do `bun test` de `packages/app` quando der, e acrescentar um job `opencode`/`core` muda o risco de cada merge que você (ou um agente) fizer amanhã.

Não precisa de um CI “completo OpenCode”. Precisa do que *este* produto quebra: sidecar build, codegen, typecheck, um smoke de shell, testes do plugin SemIf.

### 2. Um shell só — esforço **L**

**Por quê.** Enquanto `bun run --cwd packages/desktop dev` abrir Electron, você vai continuar consertando o app errado. A spec já lista a remoção. O caminho é: `dev` → Tauri, apagar `src/main`, preload, electron-vite, electron-builder, e atualizar `CONTRIBUTING.md` + `packages/desktop/README.md`. WSL / CLI install / clipboard / menu Windows ou viram commands Tauri ou saem da UI.

É L porque é mecânico e largo, não porque é ambíguo. Cada semana com os dois shells é regressão silenciosa no shim.

### 3. Identidade de produto no que o usuário instala — esforço **S/M**

**Por quê.** `identifier: "ai.opencode.desktop.v2.dev"` em `tauri.conf.json` é o ID do app no SO. Updates, data dir e coexistência com um Electron residual dependem disso. Somar: LICENSE/README sem atribuição ao OpenCode, CODEOWNERS de outra equipe, SECURITY que escala para `anoma.ly`, scheme `opencode://`, e `v0.0.7-beta.1` publicado como estável.

Isso não é “rebrand cosmética”. É o que faz o instalador parecer um produto seu, e o que evita perder o store do usuário na próxima troca de ID. Decidir: `ai.nextcode.desktop` (prod) vs `.dev`/`.beta`, e corrigir o feed/tag/prerelease para não mentir o canal.

Code-sign de OS (SmartScreen / Gatekeeper) é o passo seguinte; o README já é honesto sobre a ausência.

### 4. Retenção do event log — esforço **M**

**Por quê.** Vocês já mediram: 2,93 GB numa tabela append-only sem prune. `specs/performance-audit.md` e o item 4 de `stack-evolution.md` descrevem o invariante (`admitted_seq` / epoch / sync replay) e o fato de que delete sem `VACUUM INTO` não devolve disco. Higiene (órfãos, checkpoint, botão em Settings) já existe. Falta a política temporal + rewrite one-shot + telemetria de tamanho.

Impacto é no usuário real (disco e replay de sessão longa), não em estética de repo. Não começar um storage engine novo — a própria spec diz isso.

### 5. Fechar o contrato Tauri (segurança + stubs que a UI já chama) — esforço **M**

**Por quê.** Ordem interna, do que quebra confiança para o que quebra feature:

1. Sanitizar `store_*` (`name` sem `..` / separadores).
2. CSP mínimo no webview; `withGlobalTauri` só se ainda for necessário para o self-test — e então apagar o self-test.
3. Allowlist de scheme nos `href` do menu nativo, igual a `open_external`.
4. `runDesktopMenuAction` de verdade (o menu Windows em `packages/app/src/components/windows-app-menu.tsx` hoje no-op).
5. `readClipboardImage` e, se o produto promete, `installCli` / WSL.
6. Teste de contrato: `ElectronAPI` vs commands registrados vs shim.

O path `D:\Projetos\JevCode\...` sai no mesmo fôlego que o self-test.

---

## 6. O que já está sólido

Não é elogio genérico — são peças que eu abriria de novo e copiaria.

1. **`specs/tauri-migration.md`** é um documento de engenharia, não um pitch. Tem drivers, non-goals (Linux), porquê vs Electron, o que P0–P4 entregaram, e o que *não* entregaram. A decisão de não redesenhar `app`/`ui`/`session-ui` está justificada pelo `Platform` + `window.api`, e o código confirma.

2. **`specs/performance-audit.md` + `specs/stack-evolution.md`** medem em vez de opinar: sidecar 433–458 MB residente, WebView2 ~441 MB, total ~930 MB, `web-dist` 81,9 → 35,0 MB quando os source maps saíram do release, `event` 2,93 GB. O roadmap risca item quando o workflow existe (`tauri-shell-windows.yml`, `codegen-check.yml`). Poucos forks de dois dias têm esse hábito.

3. **O pipeline de release.** `tauri-release.yml` não é um “tauri-action e reza”: sidecar no Ubuntu por um bug real do Bun/Windows, mirror de llama.cpp porque o nightly some, signing que *não* quebra o build se o secret não existe, beta feed separado. Isso é o que permite as dez tags do dia 18 sem improviso local.

4. **SemIf.** `plugins/semif/` + `specs/semif-plugin.md`: probes de tokenizer (ids 542–557, invariante de prefixo), hash SHA-256 do GGUF, 12 testes, modos `auto`/`lazy`/`off`, sidecar HTTP em vez de `node-llama-cpp` por causa de segfault do Bun no Windows. É o único delta de produto que não é “OpenCode com outro nome”, e está escrito com o mesmo rigor das specs do shell.

5. **Allowlist de URL e tokens de anexo no Rust** (`open_external`, `open_local_file`, `read_picked_file`) copiam o Electron de propósito, com comentário apontando o TS original. O Job Object no Windows e a senha aleatória do sidecar são o mesmo tipo de detalhe: alguém fechou o processo filho e a porta.

6. **`packages/session-ui` e o i18n do desktop.** session-ui sem dívida de produção; `packages/desktop/AGENTS.md` proíbe string inglesa hardcoded e manda verificar corpus (Firefox/CLDR). `packages/session-ui` já traduziu labels de edit group para pt-BR no histórico recente (`157ac208c`). A disciplina de copy é de produto, não de scaffold.

7. **Guardas de contrato no motor herdado.** `check:generated` no client, `patched-dependencies.test.ts`, root `test` que recusa rodar na raiz, `AGENTS.md` com direção de dependência Schema → Core/Protocol → Server. Você herdou um monorepo que *sabe* como não se destruir — o gap é que esse conhecimento não está no CI do `dev`.

---

## Nota de escopo

Não rodei o app, não executei a suíte, não abri os instaladores. Os números de RAM/disco vêm dos specs do próprio repo (2026-09-18). A leitura de `main.rs`, workflows, shim e plugin foi no tree em `6d9976846`.

Se for atacar uma coisa nesta semana: **apontar os workflows existentes para `dev` + `pull_request`**. É o único item da lista que protege os outros quatro.

# SemIf — Plugin de decisões semânticas locais para o NextCode

Status: **implementado como plugin externo** (fase de estudo), candidata a promoção a recurso nativo.
Data: 2026-09-18 · Autoria: estudo conjunto com assistente IA.

---

## 1. Visão geral

O plugin `semif` contamina o conceito do [SemIf (TheoLeeCJ)](https://github.com/TheoLeeCJ/SemIf)
Italiana — "decisões semânticas" definidas em runtime: dado um estado (`evidence`),
um critério (`question`) e opções tipadas (`options`), o modelo pequeno responde
**num único forward pass**, lendo diretamente as logprobs do próximo token nos
"slots" declarados (letras A–P), sem gerar texto nem parsing de JSON.

- **Caso de uso**: micro-decisões de agente (rotear, retry, validar evidência) a custo
  baixo, sem chamar o modelo principal da sessão.
- **Modelo**: `LiquidAI/LFM2-350M` (GGUF Q4_K_M, ~219 MB) rodando **100% local** via
  `llama-server` (llama.cpp) como **sidecar HTTP**.
- **Integração**: plugin NextCode declarado em `.opencode/opencode.jsonc`, com tools
  `semif_decide` e `semif_status` e carregamento configurável do modelo
  (`auto` no start / `lazy` sob demanda / `off`).

### Por que sidecar HTTP e não node-llama-cpp in-process?

| Critério | node-llama-cpp | sidecar `llama-server` |
|---|---|---|
| Bun no Windows | segfaults reportados (oven-sh/bun#26457, #27320) | **runtime-agnóstico** |
| Logits | apenas probabilidades pós-sampler (`controlledEvaluate`), API frágil | `n_probs` no `/completion` (estável) |
| Empacotamento | binários nativos por plataforma (postinstall) | um zip (~17 MB), trivial de vendor |
| Reuso de KV (modo shared do SemIf) | não suportado para LFM2 (arquitetura híbrida) | não suportado, mas igual |

---

## 2. Validações empíricas (probe, 2026-09-18)

Executado contra `llama-server` b11040 + LFM2-350M-Q4_K_M local:

1. **Slots de letras**: `A..P` são **token único** no tokenizer LFM2, ids contíguos
   `A=542 … P=557` (via `POST /tokenize`, `add_special:false, parse_special:false`).
   ⇒ requisito estrutural do SemIf (1 token = 1 opção) satisfeito.
2. **Invariante de fronteira** (obrigatória no SemIf): para o prompt finalizado em
   `<|im_start|>assistant\n`,
   `tokenize(prompt + "A") == tokenize(prompt) ++ [542]` — prefixo idêntico, +1 token.
   Confirmado via `POST /tokenize` + comparação posicional.
3. **Template do LFM2**: `{{bos_token}}` + por turno `<|im_start|>{role}\n{content}<|im_end|>\n`,
   prompt de geração `<|im_start|>assistant\n`. Renderizado manualmente no plugin
   (determinístico) e igualado ao `/apply-template` do servidor.
   **Lição de port**: o `\n` final do template é obrigatório — sem ele o modelo
   "espera" o newline (top-1 ~40% no token `\n`) e nenhuma letra entra no top-N.
4. **Decisão end-to-end** (roteamento de suporte, 3 opções): top-1 `'A'`
   (logprob −0.41) = "Account access support.", seguido de C (−2.44) e B (−2.92):
   semântica correta com margem forte.
5. **Testes do plugin**: 12/12 pass (ver seção "Testes"), incluindo ttl de
   spawn/dispose hermético e cache.
6. **Model pin**: `sha256(LFM2-350M-Q4_K_M.gguf) =
   a4d000c7064bd3b2e42c6845836286a899a4e79cf1791da1a6797b58d575957d`
   (229.309.376 bytes; baixado de LiquidAI/LFM2-350M-GGUF).

---

## 3. Arquitetura (fase plugin)

```
┌───────────────────────────────────────────────────────────┐
│ NextCode engine (Bun)                                     │
│  ┌────────────────────────────┐                           │
│  │ plugins/semif/ (plugin)    │                           │
│  │  index.ts   hooks + tools  │                           │
│  │  config.ts  modo/paths/env │                           │
│  │  engine.ts  lifecycle      │──spawn/adopt──┐           │
│  │  scoring.ts SemIf port     │               ▼           │
│  └────────────────────────────┘  ┌──────────────────────┐  │
│                                  │ llama-server.exe     │  │
│                                  │ (b11040, HTTP 8817)  │  │
│                                  │ LFM2-350M-Q4_K_M     │  │
│                                  └──────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

### Ciclo de vida do modelo (requisito: carregar no start OU dinamicamente)

Config via opções por-plugin (`opencode.jsonc` → `plugin: [["../plugins/semif", {…}]]`):

- **`mode: "auto"`** (default) → `server(input, options)` dispara `sidecar.ensure()` **sem bloquear**
  a inicialização do engine (promise em background; a inicialização lê os
  plugins sequencialmente — pôr load pesado inline atrasaria o boot). O primeiro
  `semif_decide` aguarda a readiness promise. Validado no engine real:
  sidecar no ar ~3,6 s após o init, e `dispose` mata o processo no exit.
- **`mode: "lazy"`** → spawn na **primeira** chamada de `semif_decide`
  ("carregamento dinâmico se solicitado").
- **`mode: "off"`** → nada é carregado; `semif_decide` responde com erro claro.

Semântica do `ensure()` (idempotente, em `engine.ts`):

1. Se já pronto → resolve imediatamente.
2. Porta já ocupada? Faz `GET /health` e `GET /props`: se `model_path` casa com o
   configurado → **adota** o servidor (não mata no `dispose` — owner é outra instância).
   Se ocupada por outro modelo → tenta `port+1 … port+10`.
3. Senão, **spawn**: `spawn(serverPath, ['–m', modelPath, '--host', '127.0.0.1',
   '--port', port, '--threads', threads, '-c', contextSize, '--no-webui', '--parallel','1'])`,
   poll de health a cada 250 ms até `loadTimeoutMs` (default 60 s).
4. `dispose()` (hook `dispose` do plugin, chamado quando o engine encerra): mata apenas
   processos **spawnados por este plugin**.

### Ferramentas expostas

| Tool | Args (zod) | Comportamento |
|---|---|---|
| `semif_decide` | `state: string`, `question: string`, `options: {id, description}[] (2–16)`, `id?: string` | Garante sidecar (caminho lazy/auto), valida fronteira, 1 forward, retorna record JSON. `title` = `semif: <chosen> (p=…)`. Respeita `ctx.abort` via AbortSignal no fetch. |
| `semif_status` | `{}` | Modo, `running/adopted/spawned`, URL, portas, existência dos paths. Debug/ferramenta de diagnóstico. |

---

## 4. Semântica de scoring (port do `semif_phase1/direct.py`)

Prompt (`direct-options-v1`, igual ao SemIf upstream):

```
system: "Apply the supplied criterion to the supplied evidence. Choose exactly one
         listed option. Respond with only its uppercase letter, with no explanation
         or reasoning."
user:   JSON.stringify({ evidence: <state>, criterion: <question>,
          options: [{ letter: "A", description: <opt.description> }, …] })
```

- **Só** `evidence/criterion/options[].description` entra no prompt; `id`, `label`,
  proveniência etc. são descartados (igual a `tests/test_core.py` do upstream).
- Forward: `POST /completion` com `n_predict:1, temperature:0, n_probs: nProbs(=256)`.
  Com `temperature 0`, `top_logprobs` são **softmax puro dos logits** (comportamento
  documentado no server; `cache_prompt:false` para reprodutibilidade).
- `option_logits[i]` = logprob do token da letra i no `top_logprobs`. **Softmax é
  computado apenas sobre o subconjunto K** (identical ao `vocab[slots].softmax()` do SemIf);
  slots ausentes do top-N ficam com probabilidade 0 e aparecem em `missing_slots`.
- Cache: LRU em memória (default 128), chave `sha256(prompt)+ordem das opções`;
  hit inclui `cached:true`.
- **Registro auditável** (espelha o output SemIf):

```jsonc
{
  "id": "route-1",
  "option_ids": ["access","billing","troubleshooting"],
  "probabilities": [0.786, 0.065, 0.150],
  "option_logits": [-0.47, -2.97, -2.13],
  "answer_token_ids": [542, 543, 544],
  "chosen": "access",
  "input_tokens": 116,
  "prompt_sha256": "…",
  "prompt_version": "direct-options-v1",
  "model": { "source": "LiquidAI/LFM2-350M", "revision": "Q4_K_M", "server": "llama.cpp b11040" },
  "probability_status": "conditional option score; uncalibrated as decision confidence",
  "readout": "llama.cpp server top-k next-token logprobs at declared answer slots",
  "forward_seconds": 0.238, "total_seconds": 0.31,
  "missing_slots": [],
  "cached": false
}
```

---

## 5. Configuração

`.opencode/opencode.jsonc` (já configurado no clone):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["../plugins/semif", {
      "mode": "auto",            // "auto" | "lazy" | "off"
      "modelPath": "C:\\Users\\Gabriel\\Desktop\\semif-workspace\\models\\LFM2-350M-Q4_K_M.gguf",
      "serverPath": "C:\\Users\\Gabriel\\Desktop\\semif-workspace\\bin\\b11040\\llama-server.exe",
      "port": 8817,
      "threads": 4
    }]
  ]
}
```

Opções completas (merge: defaults < env < arquivo):

| Opção | Env | Default |
|---|---|---|
| `mode` | `SEMIF_MODE` | `auto` |
| `modelPath` | `SEMIF_MODEL_PATH` | path do workspace dev |
| `serverPath` | `SEMIF_SERVER_PATH` | `…\bin\b11040\llama-server.exe` |
| `host` | — | `127.0.0.1` |
| `port` | `SEMIF_PORT` | `8817` |
| `threads` | `SEMIF_THREADS` | `4` |
| `contextSize` | — | `2048` |
| `nProbs` | `SEMIF_NPROBS` | `256` |
| `loadTimeoutMs` | — | `60000` |
| `cacheSize` | — | `128` (0 desabilita) |

---

## 6. Como rodar / testar

```powershell
# suíte completa (12 testes; testa hermeticamente na porta 8819 — não mexe no 8817)
cd C:\Users\Gabriel\Desktop\nextcode\plugins\semif
& "C:\Users\Gabriel\.bun\bin\bun.exe" run test.ts

# smoke de integração (import do entry como o engine faz)
& "C:\Users\Gabriel\.bun\bin\bun.exe" run smoke.ts

# servidor manual (o mesmo que o plugin spawn)
C:\Users\Gabriel\Desktop\semif-workspace\bin\b11040\llama-server.exe `
  -m C:\Users\Gabriel\Desktop\semif-workspace\models\LFM2-350M-Q4_K_M.gguf `
  --host 127.0.0.1 --port 8817 --threads 4 -c 2048 --no-webui
```

Arquivos: `plugins/semif/{index,engine,scoring,config,test,smoke}.ts` — sem dependências
novas além de `@opencode-ai/plugin` (workspace) e `node:` builtins.

---

## 7. Limitações conhecidas (honestas)

1. **Top-N**: o `llama-server` só expõe top-K do vocabulário (~65k). Com `nProbs=256`
   quase todas as letras cabem (14/16 no top-100), mas slots abaixo do corte ficam com
   prob 0 (reportado em `missing_slots`). Solução nativa possível: endpoint com
   logprobs por id arbitrário no llama.cpp upstream.
2. **Sem reuso de KV**: LFM2 é híbrido (conv+atenção) — os modos `serial`/`shared` do
   SemIf (prefill + sufixos paralelos) são **impossíveis** para esse modelo; cada decisão
   é 1 forward completo (~0.2–0.3 s CPU para o exemplo de 116 tokens).
3. **Calibração**: probabilidades são *condicionais às opções* e **não calibradas** como
   confiança (sem broken do upstream). Validar por workload antes de usar criticamente.
4. Single-forward single-user: sem batching server-side (`--parallel 1`).

---

## 8. Plano de promoção a recurso nativo do NextCode

1. **Empacotar**: mover `plugins/semif/` para um pacote workspace (ex.
   `packages/semif`) com `package.json` (`exports: { "./server": "./src/index.ts" }`,
   `engines.opencode`, deps `@opencode-ai/plugin`), seguindo
   `AGENTS.md` ( Dependency direction: plugin → `@opencode-ai/plugin` apenas).
2. **Schema de config**: promover as opções para
   `packages/core/src/v1/config/` (novo bloco `semif` ou plugin options tipadas) com
   validação de schema.
3. **OMG binários**: vendor do `llama-server.exe` por plataforma no installer/unupdates
   (ex. `packages/desktop` recursos) + campos `binPath` explícitos; build CUDA/Vulkan
   opcional via release variants (`-cuda-12.4`, `-vulkan`).
4. **Modelos**: download pinado por SHA256 (reuso do "model pin" acima) num
   diretório registry global (`Global.Path.config/models`), seleção de quant por config.
5. **Integração com chat** (fase 2): hooks `chat.params` (temperatura/custo),
   `experimental.chat.system.transform` (injetar estado) e
   `experimental.provider.small_model` como uso do modelo local.
6. **Testes nativos**: trazer `test.ts` para `packages/semif/test` (Bun test), com
   fixture GGUF pequena e porta randômica; CI com runner Windows/macOS.
7. **Documentação**: esta spec é a base; adicionar seção no `README.md` do repo.

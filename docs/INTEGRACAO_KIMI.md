# Integração com Kimi Code CLI

Este documento descreve como usar o **DeepsProxy** como backend OpenAI-compatível do
[Kimi Code CLI](https://github.com/...), permitindo que o agente de código da Moonshot
converse e execute ferramentas com modelos DeepSeek servidos via `chat.deepseek.com`.

---

## Visão geral

O Kimi Code CLI conecta-se a provedores de modelo via base URL OpenAI-compatível. O
DeepsProxy expõe essa interface em `http://localhost:3000/v1`, roteando as chamadas para
o DeepSeek por meio de uma sessão persistente do Playwright (headers de autenticação +
PoW).

```
Kimi Code CLI ── openai_legacy ──▶ DeepsProxy (:3000) ──▶ chat.deepseek.com
                                    (Playwright session)
```

---

## Pré-requisitos

- Node.js v20+ e npm
- DeepsProxy rodando localmente (porta 3000)
- Kimi Code CLI instalado (pacote `kimi-code`)

---

## 1. Subir o DeepsProxy

```bash
cd deepsproxy
npm install
PLAYWRIGHT_CHANNEL=chrome DEEPSPROXY_INSECURE_TLS=true npm start
```

> **Nota sobre o browser**: se o download do Chromium do Playwright falhar na sua rede
> (ou você já tem Chrome/Edge instalados), use `PLAYWRIGHT_CHANNEL=chrome` (ou `msedge`)
> para usar o navegador do sistema.

> **Nota sobre TLS**: `DEEPSPROXY_INSECURE_TLS=true` relaxa a verificação do certificado
> na conexão com `chat.deepseek.com`. Use **apenas** em redes confiáveis. É necessário
> quando um antivírus/firewall com inspeção SSL injeta um certificado auto-assinado de
> forma intermitente, causando erros `SELF_SIGNED_CERT_IN_CHAIN`. Em redes normais, você
> pode omitir essa variável.

Na primeira execução, pode ser necessário autenticar na conta DeepSeek:

```bash
npm run login   # abre navegador para login e salva a sessão em deepseek_profile/
```

Confirme que o servidor está de pé:

```bash
curl http://localhost:3000/v1/models
```

---

## 2. Configurar o Kimi Code CLI

O Kimi Code CLI usa o tipo de provider `openai_legacy` para qualquer base URL
OpenAI-compatível. Crie um arquivo de configuração isolado (ex.: `kimi-config.toml`):

```toml
# Exemplo: integration/kimi-config.toml
[provider.deepsproxy]
type = "openai_legacy"
base_url = "http://localhost:3000/v1"
api_key = "sk-no-key-required"

[model.deepsproxy/deepseek-v4-flash]
provider = "deepsproxy"
name = "deepseek-v4-flash"
max_context_size = 131072

[model.deepsproxy/deepseek-v4-flash-thinking]
provider = "deepsproxy"
name = "deepseek-v4-flash-thinking"
max_context_size = 131072

[model.deepsproxy/deepseek-v4-pro]
provider = "deepsproxy"
name = "deepseek-v4-pro"
max_context_size = 131072

[model.deepsproxy/deepseek-v4-pro-thinking]
provider = "deepsproxy"
name = "deepseek-v4-pro-thinking"
max_context_size = 131072

default_model = "deepsproxy/deepseek-v4-flash-thinking"
```

> O `api_key` pode ser um valor dummy; o DeepsProxy não exige uma chave real localmente.

---

## 3. Testar

### Chat simples (sem ferramentas)

```bash
PYTHONUTF8=1 kimi \
  --config-file kimi-config.toml \
  --model deepsproxy/deepseek-v4-flash \
  --prompt "Explique em uma frase o que é um proxy." \
  --print
```

### Tool calling (ferramentas)

```bash
PYTHONUTF8=1 kimi \
  --config-file kimi-config.toml \
  --model deepsproxy/deepseek-v4-flash \
  --prompt "Liste os arquivos do diretório atual usando a ferramenta Shell." \
  --print
```

O Kimi CLI deve invocar a ferramenta `Shell`, e o resultado real do comando deve ser
exibido — não o XML/DSML cru.

---

## 4. Como o DeepsProxy lida com tool calling

O DeepSeek em `chat.deepseek.com` emite chamadas de ferramenta em dois formatos:

1. **`<tool_call>` JSON** — quando instruído com um pequeno conjunto de ferramentas.
2. **DSML (DeepSeek Markup Language)** — formato nativo, preferido pelo DeepSeek quando
   o cliente envia **muitas ferramentas + prompt de sistema longo em streaming** (caso
   típico do Kimi Code CLI, que expõe ~14 ferramentas).

O DSML usa o delimitador `<｜｜DSML｜｜>` (dois fullwidth pipes U+FF5C ao redor da palavra
literal "DSML"). Um exemplo do que o DeepSeek emite:

```
<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="Shell">
<｜｜DSML｜｜ parameter name="command" string="true">ls -la</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ invoke>
<｜｜DSML｜｜ calls>
```

O `src/routes/chat.ts` converte automaticamente ambos os formatos em `tool_calls`
estruturados do OpenAI, então o cliente (ex.: kosong/Kimi CLI) recebe chamadas de
ferramenta padronizadas. Os wrappers `<｜｜DSML｜｜ calls>` são descartados e não vazam para o
conteúdo visível ao usuário.

---

## 5. Solução de problemas

| Sintoma | Causa provável | Ação |
|---------|----------------|------|
| Erros `SELF_SIGNED_CERT_IN_CHAIN` intermitentes ao chamar o DeepSeek | Interceptação TLS (antivírus/firewall) injetando cert auto-assinado | Iniciar com `DEEPSPROXY_INSECURE_TLS=true` |
| Playwright trava ao baixar o Chromium | Rede bloqueando o download | Usar `PLAYWRIGHT_CHANNEL=chrome` (ou `msedge`) |
| `403 account suspended` / `401 login required` | Sessão DeepSeek inválida/expirou | Rodar `npm run login` novamente |
| Porta 3000 ocupada / processo órfão segurando `deepseek_profile` | Servidor anterior não finalizou | Matar o processo: `taskkill //PID <pid> //F` (Windows) |
| Saída do Kimi CLI com caracteres quebrados no Windows | Console em codepage cp1252 | Prefixar com `PYTHONUTF8=1` |

---

## Observações de segurança

- `DEEPSPROXY_INSECURE_TLS=true` desabilita a verificação do certificado na conexão com
  `chat.deepseek.com`. Isso é um trade-off de segurança e deve ser usado somente em redes
  confiáveis.
- O DeepsProxy usa sua conta DeepSeek (via sessão do Playwright). Respeite os Termos de
  Serviço da DeepSeek.

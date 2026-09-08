# cork-ai — Documentación en español

[![CI](https://github.com/mqthys62/cork-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/mqthys62/cork-ai/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Reduce un 60–75% los tokens en sesiones largas — sin cambiar cómo trabajas.**

> [English (principal)](../README.md) · [Français](README.fr.md)

---

## ¿Qué es cork-ai?

Cada vez que Claude Code hace una llamada a la API, envía el **historial completo** — cada archivo leído, cada salida bash, cada cabecera repetida. En una sesión de 2 horas, eso supera fácilmente **100.000 tokens por solicitud**, la mayoría redundantes.

cork-ai se interpone entre Claude Code y la API de Anthropic. Comprime lo redundante antes de cada llamada. **Tu flujo de trabajo no cambia. Los resultados no cambian. La factura, sí.**

```
Claude Code lee un archivo
        ↓
cork-ai intercepta (hook PreToolUse Read)
        ↓
Comprime: extrae firmas, trunca boilerplate
        ↓
Claude recibe el resumen comprimido en vez del archivo completo
        ↓
60–90% menos tokens por Read — automáticamente, en cada sesión
```

---

## Instalación

**Sin Node.js, sin npm.** cork-ai es un binario standalone.

### macOS / Linux / WSL2

```bash
curl -fsSL https://raw.githubusercontent.com/mqthys62/cork-ai/main/scripts/install.sh | sh
```

Descarga el binario correcto para tu OS + arquitectura, lo coloca en `~/.local/bin` y ejecuta `cork-ai hooks install`.

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/mqthys62/cork-ai/main/scripts/install.ps1 | iex
```

### Descarga manual

[Releases de GitHub](https://github.com/mqthys62/cork-ai/releases/latest) → descarga el binario para tu plataforma:

| Plataforma | Archivo |
|------------|---------|
| Linux x64 | `cork-ai-linux-x64` |
| Linux arm64 | `cork-ai-linux-arm64` |
| macOS Intel | `cork-ai-darwin-x64` |
| macOS Apple Silicon | `cork-ai-darwin-arm64` |
| Windows x64 | `cork-ai-windows-x64.exe` |

```bash
chmod +x cork-ai-linux-x64
mv cork-ai-linux-x64 ~/.local/bin/cork-ai
cork-ai hooks install
```

Listo. Reinicia Claude Code — la compresión está activa para todas tus sesiones en todos tus proyectos.

---

## Cómo funciona — 7 estrategias de compresión

| # | Qué se desperdicia | Cómo lo soluciona cork-ai | Ahorro |
|---|-------------------|---------------------------|--------|
| 1 | **Lecturas de archivos** — cada `Read` envía el archivo completo, siempre | Extrae firmas de código, trunca bash, aplana JSON | **30–50%** |
| 2 | **Cabeceras repetitivas** — Claude Code inyecta CWD, OS, archivos abiertos en cada mensaje | Conserva la primera, reemplaza el resto con un diff corto | **5–10%** |
| 3 | **Código duplicado** — el código recién escrito en disco se reenvía en el historial | Reemplazado por `[code written to src/foo.ts — omitted]` | **10–20%** |
| 4 | **Historial irrelevante** — vieja discusión de CSS mientras se depura SQL | Scoring de relevancia, resume los mensajes de baja puntuación a una línea | **15–25%** |
| 5 | **Conceptos repetidos** — la misma idea expresada de 5 formas distintas | TF-IDF + similitud Jaccard, reemplaza casi-duplicados con una referencia | **10–15%** |
| 6 | **Mensajes viejos verbosos** — texto de exploración que podría ocupar el 10% | Resumido preservando verbatim rutas, errores y decisiones | **20–30%** |
| 7 | **Arranque en frío** — la siguiente sesión redescubre todo el proyecto desde cero | Snapshot comprimido del proyecto, recargado al inicio | **40–60%** siguiente sesión |

cork-ai es **adaptativo**: no hace nada en sesiones cortas y escala la compresión a medida que el contexto crece.

---

## Resultados medidos

| Duración de sesión | Sin cork-ai | Con cork-ai | Reducción |
|-------------------|------------|------------|-----------|
| Corta (< 30 min) | ~15.000 tokens | ~12.000 | ~20% |
| Media (1h) | ~60.000 tokens | ~22.000 | **~63%** |
| Larga (2h+) | ~140.000 tokens | ~38.000 | **~73%** |
| Siguiente sesión (mismo proyecto) | ~50.000 tokens | ~18.000 | **~64%** |

Combinado con [RTK](https://github.com/rtk-ai/rtk): **75–85% de reducción total** en sesiones largas.

---

## CLI

### `cork-ai hooks install`

Registra los hooks de cork-ai globalmente en `~/.claude/settings.json`. Activos para todas las sesiones en todos los proyectos, sin configuración por proyecto. Vuelve a ejecutarlo tras actualizar: añade los hooks que le faltan a una instalación antigua y reapunta la ruta del binario.

```bash
cork-ai hooks install   # activar / actualizar
cork-ai hooks status    # cuáles de los 5 hooks están activos
cork-ai hooks remove    # desactivar
```

| Hook | Función |
|------|---------|
| `PreToolUse` **Read** | Las lecturas de archivos completos reciben un esquema numerado cuando la puerta de valor esperado dice que compensa |
| `PreToolUse` **Bash** | Lo mismo para `cat archivo`, `nl`, `bat`, `rtk proxy cat` — en modo auto, Claude Code lee por Bash, no por `Read`. Las lecturas dirigidas (`sed -n`, `head`, `tail`) siempre pasan, y `sed -i` / las redirecciones marcan el archivo como en edición |
| `PostToolUse` **Edit / Write** | Edit fallidos sobre archivos esquematizados, seguimiento de archivos editados, guardia de contexto |
| `UserPromptSubmit`, `Stop` | Avisos de la guardia de contexto |

El hook nunca comprime a costa del modelo. Las salvaguardas, todas medidas en transcripciones reales:

- **Una puerta de valor esperado decide lectura a lectura** — `tokens ahorrados × amplificación × precio cache-read` frente a `P(relectura) × (esquema inútil + un turno extra sobre el contexto actual + salida)`. Archivos pequeños, contextos enormes y extensiones que fallan repetidamente se sirven sin comprimir. `P(relectura)` se aprende por extensión en tu máquina (`~/.cork-ai/policy.json`).
- **El esquema es navegable** — cada entrada lleva su número de línea (`L127  export async function fetchAll(...)`): lo siguiente es `Read offset=127 limit=40` o `sed -n '127,166p'`, no una relectura completa.
- **Las lecturas con `offset`/`limit` explícitos nunca se comprimen** — el modelo apunta a una zona precisa.
- **Las relecturas se sirven sin comprimir**, se recuerdan entre sesiones (`skip-list.json`), y su coste — los tokens brutos *y* el turno API extra — se descuenta en `cork-ai gain`.
- **Los archivos en edición se sirven sin comprimir** — un `Edit`, `Write`, `sed -i` o una redirección sobre un archivo lo pasa a bruto durante la sesión.
- **El archivo del que habla el usuario nunca se comprime** — si tu último mensaje menciona `interceptor.ts`, su lectura pasa intacta.
- **Los Edit fallidos se detectan** — un `Edit` que falla en un archivo visto solo esquematizado añade el archivo a la lista blanca y reporta el daño.

### `cork-ai context`

Adónde va el dinero, según las transcripciones de Claude Code: por sesión, el contexto medio y máximo, el coste por turno, la parte de cache reads, y lo que los mismos turnos habrían costado con auto-compactación a 150k / 200k / 300k. En un historial real de 2 meses, el **78 % del gasto eran cache reads del contexto** (400k tokens de media por turno); con auto-compactación a 200k, el mismo trabajo cuesta un **57 % menos**.

```bash
cork-ai context                        # últimos 30 días
cork-ai context --set-autocompact 200k # escribe autoCompactWindow en ~/.claude/settings.json
cork-ai context guard off              # silencia los avisos en vivo (activados por defecto)
```

La **guardia de contexto** avisa una vez por tramo (150k / 300k / 500k / 750k tokens) y por sesión: a ti, con el coste por llamada y la alternativa compactada; al modelo, con un breve recordatorio (agrupar comandos, leer rangos, proponer `/compact`). Nunca bloquea nada.

### `cork-ai doctor`

¿Se está llamando realmente a cork-ai? Comprueba el binario, los cinco hooks, ejecuta el hook con una carga sintética, lee el heartbeat del último evento real y compara las sesiones de Claude Code de los últimos 14 días con las que cork-ai vio — con el reparto Read / lecturas Bash que explica cualquier hueco. Ejecútalo tras un `claude update` o cuando `cork-ai gain` parezca parado.

```bash
cork-ai doctor
```

### `cork-ai calibrate`

Los recuentos de tokens y las estimaciones de coste valen lo que vale el tokenizer detrás. `calibrate` mide los factores de tokens **reales** de Claude para tu modelo mediante el endpoint gratuito `count_tokens` (muestras de código + inglés + francés) y los guarda en `~/.cork-ai/calibration.json` — todos los recuentos (librería + hook) pasan a ser exactos para ese modelo:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
cork-ai calibrate                    # usa el modelo autodetectado
cork-ai calibrate claude-sonnet-5    # o uno específico
```

¿Sin clave de API a mano? `wrapClient` también **calibra pasivamente**: en cada respuesta compara su estimación local con los tokens de prompt realmente facturados por la API y corrige el estimador automáticamente.

### `cork-ai init`

Si tienes código que llama a la API de Anthropic directamente:

```bash
cd tu-proyecto
cork-ai init
```

cork-ai escanea los archivos que instancian `new Anthropic()` y:
- **Parchea automáticamente** el archivo — añade `wrapClient` y envuelve el cliente
- **Genera** un `cork-ai-client.ts` listo para importar — si no hay cliente existente
- **Muestra instrucciones precisas** — si hay varios archivos

### `cork-ai gain`

Consulta tus ahorros tras cada sesión:

```bash
cork-ai gain              # última sesión
cork-ai gain --all        # total acumulado
cork-ai gain --history    # todas las sesiones registradas
```

### `cork-ai report`

Reporting de nivel empresarial:

```bash
cork-ai report --daily      # tendencia diaria
cork-ai report --weekly     # desglose semanal
cork-ai report --monthly    # desglose mensual
cork-ai report --projects   # por proyecto, ordenado por ahorro
cork-ai report --forecast   # proyección anual + ROI
cork-ai report --json       # salida legible por máquinas para dashboards / CI
```

---

## Funciona junto a RTK

[RTK](https://github.com/rtk-ai/rtk) y cork-ai cubren capas completamente distintas — están diseñados para usarse juntos.

```
Lo que RTK comprime (llamadas Bash):
  git status, git diff, cargo test, npm test, docker ps, grep, ls …
  → 60–90% de ahorro en salidas de comandos shell

Lo que cork-ai comprime (herramientas nativas de Claude Code + conversación):
  Read → contenido de archivos comprimido en firmas
  Historial → cabeceras deduplicadas, código deduplicado, mensajes viejos resumidos
  → 40–90% en lecturas de archivos, 20–60% en historial de conversación

─────────────────────────────────────────────────────────────────
Juntos → 75–85% de reducción total en sesiones largas
```

```bash
# RTK — compresión de comandos Bash
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
rtk init -g

# cork-ai — compresión de la herramienta Read + historial
curl -fsSL https://raw.githubusercontent.com/mqthys62/cork-ai/main/scripts/install.sh | sh
```

---

## cork-ai vs las funciones nativas de Anthropic

La API de Anthropic ya incluye gestión de contexto del lado del servidor. cork-ai está diseñado para complementarla, no para competir con ella — cuándo usar qué:

| Necesidad | Usar | Por qué |
|---|---|---|
| Conversaciones largas cerca del límite de contexto | **Compaction nativa** (beta `compact-2026-01-12`) | Resumen del lado del servidor, consciente del modelo — mejor calidad que cualquier heurística del cliente |
| Limpiar resultados de herramientas antiguos en bucles agénticos | **Context editing nativo** (`clear_tool_uses_20250919`) | Poda del lado del servidor, sin lógica en el cliente |
| El historial reenviado cuesta tarifa completa en cada turno | **Prompt caching** (`cache_control`) | Las lecturas de caché cuestan 0,1× — la mayor palanca de coste |
| Reducir el contenido **antes de que entre en el contexto** (lecturas de archivos, salidas de herramientas) | **cork-ai** | La API solo puede gestionar tokens ya enviados — cork-ai evita que se envíen |
| Medir lo que la compresión ahorra de verdad | **cork-ai** | Contabilidad con datos reales de `response.usage`, por modelo, por sesión |

Dos reglas que cork-ai sigue para mantenerse compatible con el prompt caching:

1. **Estabilidad del prefijo** (por defecto en `wrapClient`): las decisiones de compresión sobre mensajes antiguos se congelan byte a byte entre peticiones. Reescribir el prefijo en cada turno invalidaría el prompt cache y costaría hasta 8× más que no comprimir nada.
2. **Contabilidad consciente del caché**: el ahorro sobre contenido ya congelado se valora a la tarifa cache-read (0,1×), no a la tarifa de input — sin cifras infladas.

---

## API de librería (para desarrolladores de apps IA)

Si estás construyendo una aplicación que llama a la API de Anthropic directamente, puedes usar cork-ai como librería para comprimir tu historial automáticamente.

Compilar desde el código fuente:

```bash
git clone https://github.com/mqthys62/cork-ai.git
cd cork-ai && npm install && npm run build
```

Luego importar desde `./dist`:

### Niveles de compresión adaptativos (solo API de librería)

Al usar `wrapClient()` o `CtxForge`, cork-ai cuenta los tokens en tu array `messages[]` y decide el nivel de compresión según cuánto se ha llenado la ventana de contexto. Controlas el presupuesto con `maxContextTokens`.

```
Uso de tokens / maxContextTokens   Nivel    Qué se ejecuta
──────────────────────────────────────────────────────────────────────
< 40%   → Passthrough   Nada — el contexto es pequeño.
40–65%  → Nivel 1       Tool results + Headers
65–80%  → Nivel 2       + Code dedup + Heatmap
> 80%   → Nivel 3       + Semantic dedup + Summarizer
```

Ajusta `maxContextTokens` según tu ventana de contexto real:

```typescript
// Empezar antes — en una ventana de 200k de Claude,
// la compresión empieza en 20k tokens en lugar de 80k
wrapClient(client, { maxContextTokens: 50_000 })
```

> **Nota**: Esta lógica adaptativa solo aplica a la API de librería. El hook de Claude Code
> comprime **cada** lectura de archivo de forma incondicional — no conoce el tamaño de la
> conversación, y eso es intencional.


```typescript
import Anthropic from '@anthropic-ai/sdk'
import { wrapClient } from './dist/index.js'

const client = wrapClient(new Anthropic(), {
  maxContextTokens: 150_000,
  aggressiveness: 0.6,
})

// Interfaz idéntica al SDK bruto — sin cambios en el resto del código
const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  messages: historial,
})
```

---

## Compatibilidad

- **SO**: Linux (Ubuntu 20.04+, Debian, Alpine), macOS (Intel + Apple Silicon), Windows (nativo + WSL2)
- **Sin dependencias runtime** — binario standalone, sin Node.js ni npm
- **API de librería**: requiere Node.js ≥ 18 y `@anthropic-ai/sdk ≥ 0.20.0`

---

## Contribuir

Ver [CONTRIBUTING.md](../CONTRIBUTING.md).

## Licencia

MIT © 2026 mqthys62

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

Requiere Claude Code 2.1.139 o más reciente: en Windows los hooks se instalan en forma exec (`command` + `args`), la única que funciona tanto si Claude Code ejecuta los hooks con Git Bash como con PowerShell. `cork-ai doctor` lo indica si la versión es demasiado antigua.

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

## CLI

### `cork-ai hooks install`

Registra los hooks de cork-ai globalmente en `~/.claude/settings.json`. Activos para todas las sesiones en todos los proyectos, sin configuración por proyecto. Vuelve a ejecutarlo tras actualizar: añade los hooks que le faltan a una instalación antigua y reapunta la ruta del binario.

```bash
cork-ai hooks install   # activar / actualizar
cork-ai hooks status    # cuáles de los 6 hooks están activos
cork-ai hooks remove    # desactivar
```

| Hook | Función |
|------|---------|
| `PreToolUse` **Read** | Las lecturas de archivos completos reciben un esquema numerado cuando la puerta de valor esperado dice que compensa |
| `PreToolUse` **Bash / PowerShell** | Lo mismo para `cat archivo`, `nl`, `bat`, `rtk proxy cat`, y `Get-Content` / `gc` / `type` en PowerShell — en modo auto, Claude Code lee por el shell, no por `Read`. Las lecturas dirigidas (`sed -n`, `head`, `tail`, `-TotalCount`) siempre pasan, y `sed -i` / las redirecciones marcan el archivo como en edición |
| `PostToolUse` **Edit / Write** | Edit fallidos sobre archivos esquematizados, seguimiento de archivos editados, guardia de contexto |
| `UserPromptSubmit`, `Stop` | Avisos de la guardia de contexto |
| `SessionEnd` | Resumen de sesión (`~/.cork-ai/digests/`, mostrado por `cork-ai gain`) |

El hook nunca comprime a costa del modelo. Las salvaguardas, todas medidas en transcripciones reales:

- **Una puerta de valor esperado decide lectura a lectura** — `tokens ahorrados × amplificación × precio cache-read` frente a `P(relectura) × (esquema inútil + un turno extra sobre el contexto actual + salida)`. Archivos pequeños, contextos enormes y extensiones que fallan repetidamente se sirven sin comprimir. `P(relectura)` se aprende por extensión en tu máquina (`~/.cork-ai/policy.json`).
- **El esquema es navegable** — cada entrada lleva su número de línea (`L127  export async function fetchAll(...)`): lo siguiente es `Read offset=127 limit=40` o `sed -n '127,166p'`, no una relectura completa.
- **Las lecturas con `offset`/`limit` explícitos nunca se comprimen** — el modelo apunta a una zona precisa.
- **Un archivo que ya está en el contexto no se envía dos veces** — la *caché de relectura*: un archivo servido completo antes en la sesión, sin cambios desde entonces (mtime, tamaño y hash del contenido coinciden) y no perdido en una compactación, recibe un recordatorio de 80 tokens en lugar del archivo. Archivos editados, archivos citados en tu prompt, lecturas por rango y lecturas de otro agente nunca pasan por la caché; un solo fallo (el modelo relee igualmente) devuelve el archivo a completo durante la sesión. Se desactiva con `cork-ai config set policy.reReadCache false`.
- **Los subagentes de solo lectura tienen un listón más bajo** — Explore y Plan nunca editan lo que leen y su contexto se descarta al final: reciben outline desde 800 tokens ahorrados en vez de 1 500 e ignoran la regla de «archivo en edición»; el resto de agentes (general-purpose, forks, agentes personalizados) sigue las reglas de la conversación principal. Se desactiva con `cork-ai config set policy.readonlyAgentsAggressive false`.
- **Las relecturas se sirven sin comprimir**, se recuerdan entre sesiones (`skip-list.json`), y su coste — los tokens brutos *y* el turno API extra — se descuenta en `cork-ai gain`.
- **Los archivos en edición se sirven sin comprimir** — un `Edit`, `Write`, `sed -i` o una redirección sobre un archivo lo pasa a bruto durante la sesión.
- **El archivo del que habla el usuario nunca se comprime** — si tu último mensaje menciona `interceptor.ts`, su lectura pasa intacta.
- **Los Edit fallidos se detectan** — un `Edit` que falla en un archivo visto solo esquematizado añade el archivo a la lista blanca y reporta el daño.

### `cork-ai context`

Adónde va el dinero, según las transcripciones de Claude Code: por sesión, el contexto medio y máximo, el coste por turno, la parte de cache reads, y lo que los mismos turnos habrían costado con auto-compactación a 150k / 200k / 300k. En un historial real de 2 meses, el **78 % del gasto eran cache reads del contexto** (400k tokens de media por turno); con auto-compactación a 200k, el mismo trabajo cuesta un **57 % menos**. Cómo se calcula cada cifra: [docs/METHODOLOGY.md](METHODOLOGY.md) (en inglés).

```bash
cork-ai context                        # últimos 30 días
cork-ai context --set-autocompact 200k # escribe autoCompactWindow en ~/.claude/settings.json
cork-ai context guard off              # silencia los avisos en vivo (activados por defecto)
```

La **guardia de contexto** avisa una vez por tramo (150k / 300k / 500k / 750k tokens) y por sesión: a ti, con el coste por llamada y la alternativa compactada; al modelo, con un breve recordatorio (agrupar comandos, leer rangos, proponer `/compact`). Nunca bloquea nada.

### `cork-ai doctor`

¿Se está llamando realmente a cork-ai? Comprueba el binario, los seis hooks (y su forma en Windows), la versión de Claude Code frente al rango probado, ejecuta el hook con una carga sintética, lee el heartbeat del último evento real y compara las sesiones de Claude Code de los últimos 14 días con las que cork-ai vio — con el reparto Read / lecturas Bash que explica cualquier hueco. Ejecútalo tras un `claude update` o cuando `cork-ai gain` parezca parado.

```bash
cork-ai doctor
CORK_AI_DEBUG=1 claude     # el hook registra los errores silenciados y una línea por evento en ~/.cork-ai/debug.log
```

### `cork-ai calibrate`

Los recuentos de tokens y las estimaciones de coste valen lo que vale el tokenizer detrás. `calibrate` mide los factores de tokens **reales** de Claude para tu modelo mediante el endpoint gratuito `count_tokens` (muestras de código + inglés + francés) y los guarda en `~/.cork-ai/calibration.json` — todos los recuentos (librería + hook) pasan a ser exactos para ese modelo:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
cork-ai calibrate                    # usa el modelo autodetectado
cork-ai calibrate claude-sonnet-5    # o uno específico
```

¿Sin clave de API a mano? `wrapClient` también **calibra pasivamente**: en cada respuesta compara su estimación local con los tokens de prompt realmente facturados por la API y corrige el estimador automáticamente.

### `cork-ai gain`

Consulta tus ahorros tras cada sesión:

```bash
cork-ai gain              # sesión en curso, o el resumen de la última sesión terminada
cork-ai gain --sessions   # los 10 últimos resúmenes: duración, turnos, contexto, coste, ahorro a 200k (--json)
cork-ai gain --all        # total acumulado
cork-ai gain --history    # todas las sesiones registradas
```

Los resúmenes se escriben en `SessionEnd` y se conservan 30 días (`reset --digests` los borra).

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

## Con RTK y las funciones nativas de Anthropic

[RTK](https://github.com/rtk-ai/rtk) reescribe comandos Bash para recortar sus salidas; cork-ai cubre lo que el README de RTK dice no alcanzar — la herramienta `Read` — más las lecturas de archivos completos hechas *a través de* Bash, y la gobernanza del tamaño de contexto que ninguno de los dos hace. La compactación y la edición de contexto del lado del servidor de Anthropic gestionan tokens ya enviados; cork-ai evita que se envíen y te avisa cuando el contexto ha crecido más de lo que cuesta mantenerlo. Las tres cosas se suman.

La librería de compresión de conversación con la que empezó cork-ai (`wrapClient`, siete estrategias) está obsoleta y documentada en [docs/SDK.md](SDK.md).

```bash
cork-ai update            # sustituye el binario por la última release (--check solo comprueba)
cork-ai config            # ajustes de ~/.cork-ai/config.json
cork-ai config set policy.reReadCache false            # desactiva la caché de relectura
cork-ai config set policy.readonlyAgentsAggressive false  # Explore/Plan siguen las reglas principales
cork-ai reset             # borra estadísticas · --policy · --skip-list · --all
cork-ai telemetry on      # eventos de uso anónimos, opt-in — qué se envía: docs/TELEMETRY.md
cork-ai telemetry preview # el payload diario exacto, byte a byte, antes de decidir
```

---

## Compatibilidad

- **SO**: Linux (Ubuntu 20.04+, Debian, Alpine), macOS (Intel + Apple Silicon), Windows (nativo + WSL2)
- **Sin dependencias runtime** — binario standalone, sin Node.js ni npm
- **Desde npm** (`npx cork-ai`): Node.js ≥ 18
- **Claude Code**: probado de 2.1.47 a 2.1.263 (`doctor` avisa fuera del rango); Windows sin Git Bash requiere ≥ 2.1.139

---

## Contribuir

Ver [CONTRIBUTING.md](../CONTRIBUTING.md).

## Licencia

MIT © 2026 mqthys62

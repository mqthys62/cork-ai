# cork-ai — Documentación en español

[![npm version](https://img.shields.io/npm/v/cork-ai.svg)](https://www.npmjs.com/package/cork-ai)
[![CI](https://github.com/mathys62/cork-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/mathys62/cork-ai/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Optimización quirúrgica del contexto para Claude Code. Reduce un 60–75% los tokens de entrada en sesiones largas.**

> [English (principal)](../README.md) · [Français](README.fr.md)

---

## El problema

En una sesión de Claude Code de 2 horas, cada solicitud a la API contiene:

- El **system prompt completo** (~2.000–5.000 tokens) — reenviado íntegramente en cada turno
- **Todo el historial de conversación** desde el inicio de la sesión
- **Todos los resultados de herramientas** (archivos leídos, salida bash, resultados de búsqueda) — completos
- **Cabeceras auto-inyectadas** (CWD, archivos abiertos, timestamp) — casi idénticas en cada mensaje

Resultado: 100.000–150.000 tokens por solicitud en sesiones largas, con costos que crecen exponencialmente.

## La solución

cork-ai aplica compresiones precisas en cada capa del contexto:

| Módulo | Qué hace | Ganancia estimada |
|--------|---------|------------------|
| Tool Result Compressor | Extrae firmas de código, trunca bash, resume JSON | **30–50%** |
| Header Stripper | Deduplica cabeceras repetitivas de Claude Code | **5–10%** |
| Code Deduplicator | Reemplaza bloques de código ya escritos en archivos | **10–20%** |
| Heatmap Manager | Resume mensajes antiguos de baja relevancia | **15–25%** |
| Semantic Deduplicator | Deduplica conceptos expresados diferente (TF-IDF) | **10–15%** |
| Selective Summarizer | Resume preservando información crítica verbatim | **20–30%** |
| Session Cache | Snapshot del proyecto entre sesiones | **40–60%** en la siguiente sesión |

**Ganancias combinadas:**

| Escenario | Sin librería | Con librería | Reducción |
|-----------|-------------|-------------|-----------|
| Sesión corta (< 30 min) | ~15.000 tokens | ~12.000 | ~20% |
| Sesión media (1h) | ~60.000 tokens | ~22.000 | ~63% |
| Sesión larga (2h+) | ~140.000 tokens | ~38.000 | ~73% |
| Siguiente sesión (mismo proyecto) | ~50.000 tokens | ~18.000 | ~64% |

---

## Instalación

```bash
npm install cork-ai
# o
yarn add cork-ai
# o
pnpm add cork-ai
```

Para el modo `wrapClient()`, se requiere `@anthropic-ai/sdk`:

```bash
npm install @anthropic-ai/sdk
```

---

## Inicio rápido — `cork-ai init`

La forma más rápida de integrar cork-ai en un proyecto existente:

```bash
cd tu-proyecto
cork-ai init
```

cork-ai escanea los archivos que instancian `new Anthropic()` y:

- **Parchea automáticamente** el archivo (añade `wrapClient`) — si se encuentra un único archivo
- **Genera** un archivo wrapper `cork-ai-client.ts` listo para usar — si no hay cliente existente
- **Muestra instrucciones precisas** — si se encuentran varios archivos

Sin fichero de configuración, sin edición manual. Ejecuta `cork-ai gain` después de tu primera sesión.

---

## Modos de uso

### Modo 1 — Middleware transparente (recomendado)

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { wrapClient } from 'cork-ai'

const client = wrapClient(new Anthropic(), {
  maxContextTokens: 150_000,
  aggressiveness: 0.6,
})

// Interfaz idéntica al SDK — no hay cambios en tu código
const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  messages: historial,
})

// Ver estadísticas
const stats = client.getStats()
console.log(`Ahorrado: ${stats?.request.savingsPercent}%`)
```

### Modo 2 — Compresión manual

```typescript
import { CtxForge } from 'cork-ai'

const forge = new CtxForge({ maxContextTokens: 150_000 })
const { messages, stats } = forge.compress(historial)

// Enviar los mensajes comprimidos a la API tú mismo
await anthropic.messages.create({ model: '...', max_tokens: 4096, messages })
```

---

## Integración con Claude Code

### Opción A — En tu wrapper de API

```typescript
// src/claude.ts
import Anthropic from '@anthropic-ai/sdk'
import { wrapClient } from 'cork-ai'

export const claude = wrapClient(new Anthropic(), {
  maxContextTokens: 150_000,
  aggressiveness: 0.6,
  onStats: (stats) => {
    if (stats.request.savingsPercent > 5) {
      process.stderr.write(`[cork-ai] ${stats.request.savingsPercent}% ahorrado\n`)
    }
  },
})
```

### Opción B — Caché entre sesiones

```typescript
import { SessionCache } from 'cork-ai'

const cache = new SessionCache()

// Al iniciar: inyectar contexto de la sesión anterior
const contextoAnterior = cache.load(process.cwd())
if (contextoAnterior) systemPrompt += '\n\n' + contextoAnterior

// Al terminar: guardar esta sesión
process.on('exit', () => cache.save(historial, process.cwd()))
```

---

## Niveles de compresión adaptativos

| Uso de tokens | Nivel | Módulos activos |
|---------------|-------|----------------|
| < 40% del presupuesto | Passthrough | Ninguno |
| 40–65% | Nivel 1 | Tool results + Headers |
| 65–80% | Nivel 2 | + Code dedup + Heatmap |
| > 80% | Nivel 3 | + Semantic dedup + Selective summarizer |

cork-ai **no hace nada** en sesiones pequeñas y se activa automáticamente a medida que crece el contexto.

---

## System prompt dinámico

```typescript
const systemPrompt = `
Instrucciones generales — siempre incluidas.

<!-- @cork-ai section: python -->
Para Python: type hints, pytest, list comprehensions.
<!-- @cork-ai end -->

<!-- @cork-ai section: typescript triggers: typescript, ts, tsx -->
Para TypeScript: tipos estrictos, sin any, imports con .js.
<!-- @cork-ai end -->
`

import { DynamicSystemPrompt } from 'cork-ai'
const dsp = new DynamicSystemPrompt()
const optimized = dsp.build(systemPrompt, mensajesRecientes)
```

---

## Compatibilidad

- **Node.js**: 18, 20, 22
- **SO**: Linux, macOS (Intel + Apple Silicon), Windows (nativo + WSL2)
- **Sin dependencias nativas**: sin binarios compilados, sin ML, sin servicios externos
- **Peer dependency**: `@anthropic-ai/sdk >=0.20.0` (opcional — solo para `wrapClient()`)

---

## Licencia

MIT © 2026 mathys62

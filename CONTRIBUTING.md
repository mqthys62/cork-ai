# Contributing to cork-ai

## Lancer les tests

```bash
# Installer les dépendances
npm install

# Lancer tous les tests
npm test

# Tests en mode watch
npm run test:watch

# Coverage
npm run test:coverage

# Vérification des types TypeScript
npm run typecheck

# Build
npm run build
```

## Ajouter un nouveau module

1. **Créer le fichier source** dans `src/compressors/` ou `src/managers/`

2. **Implémenter l'interface** `CompressResult` :
   ```typescript
   export function myModule(messages: Message[], options?: Partial<MyOptions>): CompressResult {
     return { messages: [...], savedTokens: 0 }
   }
   ```

3. **Ajouter les tests** dans `tests/unit/my-module.test.ts` :
   - Cas nominal
   - Messages vides
   - Edge cases (contenu court, déjà minimal, etc.)
   - Vérifier que le nombre de messages est préservé

4. **Enregistrer le module** dans `src/managers/budget.ts` :
   - Ajouter un `ModuleName` dans `src/types/index.ts`
   - Ajouter l'appel dans `compressWithBudget()` au bon niveau (1, 2 ou 3)

5. **Exporter depuis** `src/index.ts`

6. **Mettre à jour** `CHANGELOG.md` et `README.md`

## Convention de commits

Ce projet suit [Conventional Commits](https://www.conventionalcommits.org/) :

```
feat: ajouter un nouveau module de compression
fix: corriger le calcul des tokens dans le tokenizer
docs: mettre à jour le README avec les exemples
test: ajouter les tests d'intégration
chore: mettre à jour les dépendances
refactor: simplifier l'orchestrateur du pipeline
perf: optimiser la détection de contenu JSON
```

## Process de PR

1. **Fork** le dépôt
2. **Créer une branche** descriptive : `feat/selective-cache` ou `fix/json-detection`
3. **Écrire les tests** avant le code (TDD recommandé)
4. **Vérifier** que `npm test` et `npm run typecheck` passent
5. **Ouvrir la PR** avec une description claire
   - Ce que le module fait
   - Le gain estimé en tokens
   - Les edge cases couverts

## Règles de code

- TypeScript strict, zéro `any` sauf justification commentée
- Chaque fonction publique doit avoir un JSDoc
- Pas de dépendances ML ou natives
- Tester sur Windows (chemins avec `path.join`) et Linux
- Coverage > 80% pour tout nouveau code

## Structure des modules

```
src/
├── compressors/   # Compression directe du contenu (sans état inter-appels)
├── managers/      # Gestionnaires avec état ou orchestration
├── core/          # Infrastructure (tokenizer, pipeline, interceptor)
├── stats/         # Tracking des économies
└── types/         # Types TypeScript partagés
```

Les modules de `compressors/` et `managers/` ne se connaissent pas entre eux.
Tout passe par le pipeline (`src/core/pipeline.ts`).

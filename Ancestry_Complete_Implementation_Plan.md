# Ancestry — Complete Implementation Plan

## 1. Project Goal

Build a VS Code extension that reconstructs the **semantic evolution of a code block** across Git history, branches, and files.

### Core output

- Code ancestry timeline/tree
- Original/earliest detected occurrence
- Authors and commits
- Modified/evolved versions
- Cross-file copied logic
- Semantic similarity score
- Interactive 3D Webview visualization

---

## 2. Recommended Architecture

```text
VS Code Extension
      |
      v
Command + Code Selection
      |
      v
Analysis Orchestrator
 ┌────┼───────────────┐
 v    v               v
Git  AST Parser   Similarity Engine
 |    |               |
 └────┴───────┬───────┘
               v
        Ancestry Graph Builder
               |
               v
          Local Cache
               |
               v
       Webview / 3D Graph
```

### Main modules

```text
ancestry/
├── src/
│   ├── extension.ts
│   ├── commands/
│   ├── git/
│   ├── parser/
│   ├── normalization/
│   ├── similarity/
│   ├── graph/
│   ├── cache/
│   ├── analysis/
│   └── webview/
├── tests/
├── docs/
├── package.json
└── README.md
```

---

# 3. Technology Stack

| Technology                         | Purpose                                 |
| ---------------------------------- | --------------------------------------- |
| TypeScript                         | Main extension/backend language         |
| Node.js                            | Runtime                                 |
| VS Code Extension API              | Editor integration                      |
| Webview API                        | Visualization UI                        |
| Git CLI / simple-git               | Git history access                      |
| Tree-sitter                        | Multi-language AST parsing              |
| TypeScript AST tools               | JS/TS-specific parsing where useful     |
| AST normalization                  | Remove irrelevant syntactic differences |
| SimHash / MinHash                  | Fast similarity detection               |
| Optional embeddings                | Advanced semantic similarity            |
| Three.js                           | 3D visualization                        |
| D3.js                              | Graph/layout/data utilities             |
| SQLite                             | Local indexing/cache                    |
| Vitest                             | Unit/integration tests                  |
| ESLint + Prettier                  | Code quality                            |
| GitHub Actions                     | CI                                      |
| VS Code Extension Manager (`vsce`) | Packaging/publishing                    |

### Important scope decision

**Do not start with AI/LLMs.**

Build a deterministic AST + hashing system first. Add embeddings only after the baseline works and has measurable accuracy.

---

# 4. Development Checkpoints

## Phase 0 — Specification

### Tasks

- Define supported languages for v1.
- Recommended: **JavaScript/TypeScript first**.
- Define what counts as a "code block".
- Define similarity thresholds.
- Define graph node/edge types.

### Deliverable

`docs/specification.md`

### Checkpoint

You can explain exactly what the system detects and what it does not detect.

---

# Phase 1 — VS Code Extension Skeleton

### Build

- Initialize TypeScript VS Code extension.
- Add command:
  `Ancestry: Analyze Selected Code`
- Read current file and selection.
- Identify repository root.
- Open a Webview panel.

### Checkpoint

Selecting a function → command → Webview opens with the selected code.

---

# Phase 2 — Git Engine

Implement:

```text
getRepositoryRoot()
getCurrentCommit()
getBranches()
getCommitHistory()
getFileAtCommit()
getCommitMetadata()
getBlame()
```

Use Git commands such as:

```text
git rev-parse
git log
git show
git blame
git branch
git merge-base
```

### Checkpoint

Given a selected function, produce:

```json
{
  "file": "src/auth.ts",
  "commit": "...",
  "author": "...",
  "timestamp": "...",
  "message": "..."
}
```

---

# Phase 3 — AST Extraction

### Build

- Parse source code.
- Detect functions/classes/methods/blocks.
- Store source ranges.
- Generate AST representation.

### Important rule

**Never use regex as the primary code parser.**

### Checkpoint

The same function can be identified reliably even when formatting changes.

---

# Phase 4 — AST Normalization

Convert:

```js
function add(a, b) {
  return a + b;
}
```

and:

```js
function sum(x, y) {
  return x + y;
}
```

into approximately the same normalized representation.

Normalize:

- Variable identifiers
- Function parameter names
- Formatting
- Comments
- Literal handling where appropriate
- Equivalent syntactic structures

Do **not** remove information that changes program behavior.

### Checkpoint

Renamed variables produce the same or highly similar normalized representation.

---

# Phase 5 — Semantic Similarity Engine

### Version 1

Use:

```text
AST → normalized tokens/features → SimHash/MinHash
```

Calculate similarity.

Example:

```json
{
  "source": "auth.ts",
  "candidate": "security.ts",
  "similarity": 0.91
}
```

### Classification

```text
>= 0.90 → strong candidate
0.75–0.90 → possible candidate
< 0.75 → normally ignore
```

**These thresholds must be experimentally validated; they are not universal constants.**

### Checkpoint

Detect copied code after:

- Variable renaming
- Formatting changes
- Minor structural changes

---

# Phase 6 — History Reconstruction

For the selected block:

1. Identify current version.
2. Walk relevant commits backwards.
3. Locate previous versions.
4. Compare normalized representations.
5. Search other files when necessary.
6. Record semantic relationships.

### Relationship types

```text
EVOLVED_FROM
COPIED_FROM
MODIFIED_FROM
MOVED_FROM
MERGED_FROM
```

### Checkpoint

Generate an ancestry graph:

```text
Commit A
   |
   v
Commit B
   |
   +----> file2.ts
   |
   v
Commit C
```

---

# Phase 7 — Origin Detection

Find the earliest sufficiently similar occurrence.

Store:

```text
originFile
originCommit
originAuthor
originTimestamp
originSimilarity
```

### Important limitation

Call it:

> "Earliest detected semantic match"

NOT:

> "Proven original author/intention"

Git history cannot always establish true intent or absolute originality.

### Checkpoint

System can identify and display the earliest detected source.

---

# Phase 8 — Ancestry Graph

Create graph models.

### Node

```ts
interface CodeNode {
  id: string;
  file: string;
  commit: string;
  author: string;
  timestamp: number;
  hash: string;
  similarity?: number;
}
```

### Edge

```ts
interface CodeEdge {
  from: string;
  to: string;
  type: 'evolved' | 'copied' | 'moved' | 'merged';
  similarity?: number;
}
```

### Checkpoint

Complete graph can be serialized to JSON.

---

# Phase 9 — 3D Visualization

### Webview stack

```text
React (optional)
Three.js
Webview API
```

Recommended initial implementation:

**Vanilla TypeScript + Three.js**

Add React only if the UI becomes complex.

### Visualization

```text
X = time
Y = branch/group
Z = file/module
```

Show:

- Nodes = code versions
- Edges = relationships
- Node details on click
- Commit metadata
- Similarity score
- File path
- Author
- Timestamp

### Required interactions

- Zoom
- Pan
- Rotate
- Click node
- Highlight ancestry path
- Filter by branch
- Filter by file
- Filter by author
- Time range
- Similarity threshold

### Checkpoint

User can visually trace a code block from its current version backward.

---

# Phase 10 — Local Index & Cache

Large repositories cannot be rescanned from scratch every time.

Create SQLite tables:

```text
repositories
commits
files
code_blocks
normalized_blocks
similarity_matches
graph_edges
```

Cache:

- Commit metadata
- Parsed blocks
- Normalized AST
- Hashes
- Similarity results

### Checkpoint

Second analysis is significantly faster than the first.

---

# Phase 11 — Performance

Implement:

- Incremental Git scanning
- Hash-based cache invalidation
- Worker threads
- Candidate filtering before expensive comparison
- File/language filters
- Maximum history depth setting
- Maximum repository size safeguards

### Target

For v1, optimize for **small/medium repositories first**.

Do not claim unlimited large-repository scalability until benchmarked.

---

# Phase 12 — Testing

## Unit tests

Test:

- Git parser
- AST extraction
- Normalization
- Hashing
- Similarity
- Graph construction

## Integration tests

Create artificial Git repositories containing:

1. Original function
2. Renamed copy
3. Modified copy
4. Moved function
5. Branch divergence
6. Merge
7. Deleted/reintroduced code

## Accuracy tests

Measure:

```text
Precision
Recall
F1-score
False-positive rate
False-negative rate
```

## Performance tests

Measure:

```text
Repository scan time
Analysis time
Memory usage
Cache effectiveness
Visualization FPS
```

### Checkpoint

All critical tests pass in CI.

---

# Phase 13 — Security & Privacy

The extension should:

- Process repositories locally by default.
- Never upload source code without explicit user action.
- Clearly disclose optional external services.
- Avoid logging source-code contents.
- Sanitize Webview messages.
- Use strict Content Security Policy.
- Validate Git paths.
- Prevent command injection.
- Restrict Webview resources.

### Checkpoint

A security review finds no known critical issues.

---

# Phase 14 — Error Handling

Handle:

```text
No Git repository
Detached HEAD
Large repository
Missing Git executable
Unsupported language
Invalid source
Binary file
Shallow clone
Corrupted cache
Deleted file
Renamed file
Merge commit
Git command failure
Webview failure
```

Never crash the extension because one file/commit cannot be analyzed.

---

# Phase 15 — Public Product Polish

Add:

- Settings
- Progress indicator
- Cancellation
- Status messages
- Error messages users can understand
- README
- Screenshots/GIF
- Architecture documentation
- Demo repository
- Troubleshooting guide
- License
- Changelog
- Contribution guide
- Code of Conduct

---

# Phase 16 — CI/CD

GitHub Actions pipeline:

```text
Install
  ↓
Lint
  ↓
Type Check
  ↓
Unit Tests
  ↓
Integration Tests
  ↓
Build
  ↓
Package
```

Add:

- Dependency auditing
- Automated releases
- Version tagging

---

# 5. Final Product Workflow

```text
Developer selects function
        ↓
"Analyze Code Ancestry"
        ↓
Find Git repository
        ↓
Extract selected block
        ↓
Parse AST
        ↓
Normalize AST
        ↓
Search indexed history
        ↓
Calculate semantic similarity
        ↓
Find related versions
        ↓
Build ancestry graph
        ↓
Return graph JSON
        ↓
Render 3D Webview
        ↓
Developer explores evolution
```

---

# 6. MVP Definition

Do NOT build everything simultaneously.

### MVP must support

- VS Code extension
- JavaScript/TypeScript
- Selected function analysis
- Git history
- AST parsing
- AST normalization
- Semantic hashing
- Cross-file matching
- Basic ancestry graph
- 3D Webview
- Commit/author information

### MVP should NOT initially require

- Multiple programming languages
- LLMs
- Cloud backend
- Distributed database
- Collaboration
- GitHub SaaS integration
- Enterprise authentication

---

# 7. Version Roadmap

## v0.1 — Proof of Concept

- Extension
- Selected code
- Git history
- Basic AST

## v0.2 — Semantic Detection

- Normalization
- SimHash/MinHash
- Copy detection

## v0.3 — Ancestry

- Cross-file history
- Graph generation
- Origin detection

## v0.4 — Visualization

- Three.js
- Interactive 3D timeline

## v0.5 — Performance

- SQLite
- Incremental indexing
- Workers
- Caching

## v0.6 — Production Hardening

- Testing
- Security
- Error handling
- Large-repository safeguards

## v1.0 — Public Release

- Documentation
- CI/CD
- Demo
- Marketplace package
- Open-source repository

---

# 8. Learning Roadmap

Learn in this order:

1. **Git fundamentals + internals**
2. **TypeScript**
3. **Node.js**
4. **VS Code Extension API**
5. **AST and Tree-sitter**
6. **Static code analysis**
7. **Hashing / SimHash / MinHash**
8. **Graph data structures and algorithms**
9. **Three.js**
10. **SQLite**
11. **Testing**
12. **Security**
13. **GitHub Actions**
14. **VS Code extension packaging**

---

# 9. Definition of Done

The project is ready for public use only when:

- [ ] Extension installs successfully
- [ ] Selected functions are parsed correctly
- [ ] Git history is reconstructed correctly
- [ ] Renamed copies are detected
- [ ] False positives are measured
- [ ] Ancestry graph is correct on test repositories
- [ ] 3D visualization works
- [ ] Large-history safeguards exist
- [ ] Cache works
- [ ] Tests pass
- [ ] CI passes
- [ ] Security review is completed
- [ ] No source code is sent externally by default
- [ ] Documentation is complete
- [ ] License is included
- [ ] Demo repository is available
- [ ] Extension package installs cleanly

---

# 10. Major-Project Strategy

Treat the project as **three separate engineering problems**:

### Problem A — Code Understanding

AST + normalization + semantic similarity

### Problem B — Historical Reconstruction

Git history + cross-file/branch relationships

### Problem C — Human Understanding

Interactive 3D ancestry visualization

The project becomes strong when all three are integrated and evaluated quantitatively.

**Do not chase features before proving the semantic-matching engine works.**

The most important technical milestone is:

> Given two pieces of source code with renamed variables and moderate structural changes, correctly determine whether they represent substantially similar logic.

If that works reliably, the rest of the system can be built around it.

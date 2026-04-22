# Chronometer Web — Implementation Docs

Permanent reference documentation for the Chronometer Web codebase, organized by subsystem. These docs are distilled from the [planning archive](../planning/) and kept up to date as the codebase evolves.

> **First-time setup**: If you plan to port new watch faces or trace
> algorithms to the iOS source, run `scripts/clone-refs.sh` to clone the
> reference repositories. See [ios-reference.md](ios-reference.md) for details.

## Table of Contents

### Architecture & Design
- [**Architecture Overview**](architecture-overview.md) — High-level design decisions, part classification, multi-face grid, energy-efficient rendering, memory budget

### Core Systems
- [**Rendering**](rendering.md) — Canvas rendering pipeline, static caching, window cutouts, drawing order
- [**Animation**](animation.md) — Two-time-base system, update intervals, scrubbing, adaptive compression
- [**Expressions**](expressions.md) — Expression parser/evaluator pipeline, pre-parsed AST, `evalAttr` API
- [**XML Parsing**](xml-parsing.md) — Watch XML structure, part type taxonomy, asset resolution

### Visual Effects
- [**Shadows**](shadows.md) — Window inner shadows, hand shadows, calendar wheel shadows
- [**Terminator**](terminator.md) — Moon phase leaf display system

### Feature Systems
- [**Astronomy**](astronomy.md) — Ported astronomical routines, opcode tracing guide
- [**Calendar**](calendar.md) — Hybrid Julian/Gregorian calendar system, known correctness issues
- [**World-Time Slots**](world-time-slots.md) — Slot architecture for Terra/Gaia world-time features
- [**Location & Cities**](location-and-cities.md) — Location system, GeoNames city picker, `file://` limitations
- [**Help System**](help-system.md) — Per-face help content, Android source extraction, lazy-loading architecture

### Development
- [**Face Porting Guide**](face-porting-guide.md) — Step-by-step procedure for porting a new watch face
- [**Build System**](build-system.md) — Build pipeline, face registration, deployment
- [**iOS Reference**](ios-reference.md) — Guide to the iOS/Android reference repositories
- [**Development Rules**](development-rules.md) — Rules to follow when making changes to this project

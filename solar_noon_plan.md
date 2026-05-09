# Plan: Parameterizing Top Anchors for Japanese Dial Functions

## The Goal
Generalize both `angleForJapanHour` and `temporalAngleFor24Hour` so they can be anchored to any of the four major daily milestones: Clock Noon, Clock Midnight, Solar Noon, or Solar Midnight. This will allow us to easily configure what goes at the top of the watch face.

## The Current State
Currently, the two functions use *different* implicit anchors:
1. `angleForJapanHour(x)` calculates angles relative to a standard 24-hour clock dial. This means it implicitly anchors **Clock Noon** to the top (angle 0).
2. `temporalAngleFor24Hour(x)` evenly divides the daytime and nighttime arcs symmetrically, forcing sunrise to exactly 9 o'clock and sunset to exactly 3 o'clock. This inherently forces **Solar Noon** to exactly the top (angle 0).

## The Implementation

### 1. Define Constants
In `watch-env.ts`, we will register four constants to be used by any watch face XML:
```typescript
env.variables.set('topAnchorClockNoon', 0);
env.variables.set('topAnchorClockMidnight', 1);
env.variables.set('topAnchorSolarNoon', 2);
env.variables.set('topAnchorSolarMidnight', 3);
```

### 2. Generalize `angleForJapanHour(japanHourNumber, topAnchor)`
We will add `topAnchor` as a second parameter. We'll compute the absolute angle (as it does today), and then apply an offset:
- `topAnchorClockNoon` (0): No offset (current default).
- `topAnchorClockMidnight` (1): Subtract `Math.PI`.
- `topAnchorSolarNoon` (2): Subtract `solarNoonAngle`.
- `topAnchorSolarMidnight` (3): Subtract `solarNoonAngle + Math.PI`.

### 3. Generalize `temporalAngleFor24Hour(h, topAnchor)`
We will add `topAnchor` as a second parameter. We'll compute the angle based on the symmetrical arcs (as it does today, which natively puts Solar Noon at the top), and then apply an offset:
- `topAnchorSolarNoon` (2): No offset (current default).
- `topAnchorSolarMidnight` (3): Subtract `Math.PI`.
- `topAnchorClockNoon` (0): Subtract the angle for `h = 12` (which forces clock 12:00 to the top).
- `topAnchorClockMidnight` (1): Subtract the angle for `h = 0` (which forces clock 0:00 to the top).

### 4. Update `Kyoto-I.xml`
With the generalized functions, achieving the goal for `kyMode=0` (Variable Hour Widths, Solar Noon at the top) is incredibly straightforward. We simply pass `topAnchorSolarNoon` to all our function calls!

**For Dial Markers:**
```xml
offsetAngle='kyMode==0 ? angleForJapanHour(X, topAnchorSolarNoon) : X*pi/6'
angle='kyMode==0 ? X*pi/12+pi - solarNoonAngle() : temporalAngleFor24Hour(X, topAnchorSolarNoon)'
```
*(Note: We will still need the `solarNoonAngle()` helper to manually rotate the static 24-hour markers and the `jhr` hand, as they don't use these functions.)*

This creates a highly robust, mathematically pure system that can handle any combination of Wadokei mechanics simply by changing the `topAnchor` constant!

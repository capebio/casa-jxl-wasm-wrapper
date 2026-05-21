# @casabio/jxl-policy

Policy presets for the Casabio JXL wrapper. Pure functions, no runtime state.

A policy is an overlay of sensible defaults applied *under* caller-supplied options — caller fields always win.

## Decode policies (Section 10.3 / 9.2)

| Name | progressionTarget | emitEveryPass | priority | downsample |
|---|---|---|---|---|
| `thumbnail` | dc | false | near | 8 |
| `gallery` | dc | false | near | 4 |
| `viewer` | final | true | visible | — |
| `export` | final | false | visible | — |
| `prefetch` | dc | false | background | 4 |

```ts
import { applyDecodePolicy } from "@casabio/jxl-policy";
const opts = applyDecodePolicy("viewer", { format: "rgba8" });
```

## Encode policies (Section 11.3)

| Name | effort | progressive | previewFirst | priority |
|---|---|---|---|---|
| `thumbnail` | 2 | false | false | near |
| `viewer` | 4 | true | true | visible |
| `archival` | 7 | true | false | background |

```ts
import { applyEncodePolicy } from "@casabio/jxl-policy";
const opts = applyEncodePolicy("archival", { format: "rgba16", width, height, hasAlpha: false });
```

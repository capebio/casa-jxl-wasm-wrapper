Yes. Before any optimisation work, I'd add instrumentation around the major phases and collect:

```text
time (ns/us/ms)
allocations
bytes allocated
bytes copied
peak resident memory
```

for each section.

# Suggested Instrumentation Table

| ID   | Section                         | Lines            | Metric                            |
| ---- | ------------------------------- | ---------------- | --------------------------------- |
| T1   | TIFF header validation          | 229-249          | Time                              |
| T2   | IFD0 parse                      | 258-286          | Time, allocations                 |
| T3   | EXIF parse                      | 294-313          | Time, allocations                 |
| T4   | MakerNote parse                 | 320-334          | Time, allocations                 |
| T5   | RAW IFD parse                   | 338-366          | Time, allocations                 |
| T6   | SOF3 scan                       | 156-194; 379-381 | Time, bytes scanned               |
| T7   | Width reconstruction / geometry | 385-393          | Time                              |
| T8   | RAW decode buffer allocation    | 407-408          | Allocation count, bytes allocated |
| T9   | LJPEG decode                    | 410-413          | Time (critical metric)            |
| T10  | Crop geometry computation       | 425-453          | Time                              |
| T11  | Crop output allocation          | 458              | Allocation count, bytes allocated |
| T12  | Crop copy loop                  | 459-466          | Time, bytes copied                |
| T13  | Final image construction        | 471-485          | Time                              |
| T14  | Total decode_bytes()            | 226-485          | End-to-end time                   |

------

# Additional Memory Metrics

These are arguably more important than timing.

| ID   | Measurement                  | Location        |
| ---- | ---------------------------- | --------------- |
| M1   | Size of `raw_decoded`        | 407             |
| M2   | Size of `cropped`            | 458             |
| M3   | Combined peak image memory   | 407-466         |
| M4   | ColorData allocation size    | 320-334         |
| M5   | IFD vector allocations       | 124-148         |
| M6   | Total allocations per decode | Entire function |

------

# Derived Metrics Worth Logging

These become very useful later:

| Metric               | Formula                          |
| -------------------- | -------------------------------- |
| Decode MP/s          | `(width * height) / decode_time` |
| Crop bandwidth       | `bytes_copied / crop_time`       |
| Parse %              | `(T2+T3+T4+T5+T6)/T14`           |
| Decode %             | `T9/T14`                         |
| Copy %               | `T12/T14`                        |
| Allocation %         | allocation time / T14            |
| Peak image footprint | M1 + M2                          |

------

# What I Expect You'll See

Before measuring, my guess would be:

| Stage                | Approx Share |
| -------------------- | ------------ |
| LJPEG decode         | 70–90%       |
| Crop copy            | 5–15%        |
| TIFF parsing         | 1–5%         |
| MakerNote extraction | <1%          |
| SOF scan             | <1%          |
| Allocations          | 2–10%        |

But that's exactly why you instrument first.

The most important question to answer is:

```text
Is the decoder compute-bound
or
memory-bandwidth-bound?
```

A single metric can reveal this:

| Metric          | Calculation |
| --------------- | ----------- |
| Copy Cost Ratio | T12 / T9    |

If crop copying is more than about **10–15% of decode time**, then removing the crop copy should be your immediate optimisation target.

------

# "Must Have" Timers

If you only add five measurements, make them:

| Priority | Lines   | Name              |
| -------- | ------- | ----------------- |
| 1        | 410-413 | LJPEG decode      |
| 2        | 459-466 | Crop copy         |
| 3        | 407-408 | Decode allocation |
| 4        | 458     | Crop allocation   |
| 5        | 226-485 | Total decode      |

Those five numbers alone will tell you whether the next week should be spent on:

```text
algorithm work
memory work
or architecture work
```

which is exactly the information needed before handing optimisation tasks to an agent.
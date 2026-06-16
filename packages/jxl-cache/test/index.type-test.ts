import { createJxlCache } from "../src/index.js";
import type { JxlCache } from "../src/browser.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type _CreateJxlCacheReturnType = Expect<Equal<ReturnType<typeof createJxlCache>, JxlCache>>;

/**
 * `z.infer` produces mutable types, but the engine's shapes are deeply readonly and the
 * whole system treats messages as immutable values. Exporting the readonly form makes both
 * directions typecheck without a cast: an engine `PlayerView` flows into an outbound
 * message, and a freshly parsed message satisfies a readonly consumer.
 */
export type DeepReadonly<T> = T extends (infer E)[]
  ? readonly DeepReadonly<E>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

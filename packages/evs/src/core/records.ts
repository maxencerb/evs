/**
 * `core/records.ts` — how evs reads the members of a struct value a user passes: the builder's
 * struct positions (`builder/expr`) and the interpreter's script arguments (`ir/interp/coerce.ts`)
 * read them by this one rule, which is the rule viem's encoder follows (`value[name]`).
 */

/**
 * The member `name` of a struct record, read as JavaScript reads `record[name]`: an own property,
 * or one found on its prototype chain (a class getter, a Svelte `$state` field, a Lit
 * `@property`, an `Object.create(proto)` record), with `record` as the getter's receiver. A name
 * found only on `Object.prototype` or `Function.prototype` (`toString`, `valueOf`, `__proto__`,
 * …) is no member: it reads as `undefined`, like a member left out. Neither is the `constructor`
 * of a prototype, which is its class (a class body cannot declare a `constructor` accessor), so
 * `constructor` counts only as an own property. The unknown-member checks list own keys, which a
 * getter on a prototype is not.
 */
export function readMember(record: object, name: string): unknown {
  for (let o: object | null = record; o !== null; o = Reflect.getPrototypeOf(o)) {
    if (o === Object.prototype || o === Function.prototype) return undefined;
    if (Object.hasOwn(o, name)) {
      return o !== record && name === 'constructor' ? undefined : Reflect.get(record, name);
    }
  }
  return undefined;
}

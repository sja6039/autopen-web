/**
 * Merges a list of Tailwind class strings, filtering out any falsy values
 * (false, null, undefined). Useful for conditional className composition.
 *
 * @example cn("base-class", isActive && "active-class", undefined) → "base-class active-class"
 */
export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

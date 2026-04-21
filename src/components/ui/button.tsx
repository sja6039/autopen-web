/**
 * button.tsx — Reusable Button component.
 *
 * Variants:
 *   default   – filled violet (primary CTA)
 *   outline   – white with stone border (secondary action)
 *   ghost     – no background, subtle hover (tertiary / icon label)
 *   secondary – light stone fill (neutral alternative to outline)
 *
 * Sizes:
 *   sm      – 36px tall, compact padding
 *   default – 44px tall (touch-friendly)
 *   lg      – 48px tall (prominent CTA)
 *   icon    – 44×44px square, no padding (icon-only buttons)
 */
import * as React from "react";
import { cn } from "@/lib/utils";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost" | "secondary";
  size?: "default" | "lg" | "sm" | "icon";
}

const base =
  "inline-flex items-center justify-center rounded-xl font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40 active:scale-[0.97]";

const variants: Record<NonNullable<ButtonProps["variant"]>, string> = {
  default:
    "bg-violet-600 text-white hover:bg-violet-700 shadow-sm shadow-violet-200",
  outline:
    "border-2 border-stone-200 bg-white text-stone-700 hover:border-stone-300 hover:bg-stone-50",
  ghost: "text-stone-600 hover:bg-stone-100 hover:text-stone-800",
  secondary: "bg-stone-100 text-stone-700 hover:bg-stone-200",
};

const sizes: Record<NonNullable<ButtonProps["size"]>, string> = {
  default: "h-11 px-5 py-2 text-sm",
  lg: "h-12 px-7 text-base",
  sm: "h-9 px-3 text-sm",
  icon: "h-11 w-11 p-0",
};

/**
 * Polymorphic button that forwards its ref and spreads all native button
 * attributes. Defaults to variant="default" (violet fill) and size="default"
 * (44px height). Pass `asChild` patterns via className overrides if needed.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(base, variants[variant], sizes[size], className)}
        {...props}
      />
    );
  },
);

Button.displayName = "Button";

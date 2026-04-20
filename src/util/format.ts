/**
 * Format a token count as a compact string.
 * e.g. 68700 -> "68.7K", 1200000 -> "1.2M"
 * Matches OpenCode's Locale.number() pattern.
 */
export function formatTokens(num: number): string {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M"
  if (num >= 1_000) return (num / 1_000).toFixed(1) + "K"
  return num.toString()
}

/**
 * Format a token count as a full comma-separated number.
 * e.g. 158200 -> "158,200"
 * Used in the session sidebar where horizontal room permits precision.
 */
export function formatTokensFull(num: number): string {
  return num.toLocaleString("en-US")
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

/**
 * Format a cost value as USD currency.
 * e.g. 2.25 -> "$2.25"
 */
export function formatCost(cost: number): string {
  return money.format(cost)
}

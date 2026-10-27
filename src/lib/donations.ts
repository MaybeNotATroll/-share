const HOSTED_PAYMENT_HOSTS = new Set([
  "buy.stripe.com",
  "donate.stripe.com",
  "www.paypal.com",
  "paypal.com",
  "www.paypal.me",
  "paypal.me",
  "ko-fi.com",
  "www.buymeacoffee.com",
]);

export function donationUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !HOSTED_PAYMENT_HOSTS.has(url.hostname) || url.pathname === "/") return null;
    return url.href;
  } catch {
    return null;
  }
}

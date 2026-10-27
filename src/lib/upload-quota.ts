export type UploadQuota = {
  limitBytes: number;
  uploadedBytes: number;
  fileBytes: number;
  wouldTotalBytes: number;
  overLimitBytes: number;
  remainingBytes: number;
  reservedBytes: number;
  resetAt: string;
};

// Decimal MB: exact bytes accompany non-integral units so even a one-byte
// overage is visible and never rounded down to zero.
export function quotaSize(bytes: number): string {
  const unit = bytes >= 1_000_000_000 ? 1_000_000_000 : bytes >= 1_000_000 ? 1_000_000 : 1;
  if (unit === 1) return `${bytes.toLocaleString("en-US")} B`;
  const name = unit === 1_000_000_000 ? "GB" : "MB";
  if (bytes % unit === 0) return `${bytes / unit} ${name}`;
  return `${(bytes / unit).toFixed(unit === 1_000_000_000 ? 9 : 6).replace(/0+$/, "").replace(/\.$/, "")} ${name} (${bytes.toLocaleString("en-US")} bytes)`;
}

export function uploadQuotaMessage(quota: UploadQuota, localReset?: string): string {
  return `Upload limit exceeded. Your daily limit is ${quotaSize(quota.limitBytes)}. ` +
    `You've already uploaded ${quotaSize(quota.uploadedBytes)} today. ` +
    `This file is ${quotaSize(quota.fileBytes)}, which would bring your total to ${quotaSize(quota.wouldTotalBytes)} — ` +
    `${quotaSize(quota.overLimitBytes)} over your limit. ` +
    `You have ${quotaSize(quota.remainingBytes)} remaining today. ` +
    `Your allowance resets at ${localReset ?? `${quota.resetAt} (midnight UTC)`}.`;
}

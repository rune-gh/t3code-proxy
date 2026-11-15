import type { RecentRequestBucket } from '@/utils/recentRequests';

/** Minutes per bucket (the backend uses 20 buckets of 10 minutes). */
export const TRAFFIC_BUCKET_MINUTES = 10;

/** Aggregated traffic window. */
export interface TrafficWindow {
  buckets: RecentRequestBucket[];
  totalSuccess: number;
  totalFailure: number;
  total: number;
  /** 0-100; null when the window has no requests. */
  successRate: number | null;
  /** Largest bucket total, for the y-axis. */
  peakTotal: number;
  /** Index of the peak bucket, -1 when there is no data. */
  peakIndex: number;
  /** Window length in minutes. */
  windowMinutes: number;
}

/** Traffic for one provider. */
export interface ProviderTraffic {
  id: string;
  credentials: number;
  success: number;
  failure: number;
  total: number;
  successRate: number | null;
  buckets: RecentRequestBucket[];
}

/** Account health. */
export interface CredentialHealth {
  total: number;
  active: number;
  disabled: number;
  unavailable: number;
  /** Account count per provider type, largest first. */
  byType: Array<{ type: string; count: number }>;
}

/** Raw counts for the stat row. */
export interface DashboardCounts {
  managementKeys: number | null;
  providerKeys: number | null;
  credentials: number | null;
  models: number | null;
}

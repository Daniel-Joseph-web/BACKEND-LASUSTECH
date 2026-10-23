import { z } from 'zod';
import { prisma } from './prisma';

const cidr = z
  .string()
  .trim()
  .regex(
    /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/(3[0-2]|[12]?\d))?$/,
    'Each subnet must be an IPv4 address or CIDR range, e.g. 192.168.1.0/24.',
  );

export const settingSchemas = {
  general: z.object({
    platformName: z.string().trim().min(1).max(120),
    institutionShort: z.string().trim().min(1).max(20),
    timezone: z.enum(['Africa/Lagos', 'UTC']),
    defaultSession: z.string().trim().max(60),
    supportPhone: z.string().trim().max(30),
    liveExamMode: z.boolean(),
    maintenanceMode: z.boolean(),
  }),
  security: z.object({
    twoFactorStaff: z.boolean(),
    sessionTimeoutMins: z.number().int().min(5).max(480),
    maxLoginAttempts: z.number().int().min(3).max(20),
    lockoutDurationMins: z.number().int().min(1).max(1440),
    passwordExpiryDays: z.number().int().min(0).max(730), // 0 = never
    enforceSingleSession: z.boolean(),
    cbtSubnets: z.array(cidr).max(50),
  }),
  exam: z
    .object({
      autosaveSeconds: z.number().int().min(1).max(60),
      heartbeatSeconds: z.number().int().min(2).max(120),
      disconnectClockPolicy: z.enum(['RUNNING', 'PAUSE_ON_DISCONNECT']),
      autoSubmitOnExpiry: z.boolean(),
      lateLoginGraceMins: z.number().int().min(0).max(120),
      lateLoginCutoffMins: z.number().int().min(0).max(240),
      tabSwitchLimit: z.number().int().min(0).max(20),
      antiCheatEnabled: z.boolean().default(true),
      shuffleQuestions: z.boolean(),
      shuffleOptions: z.boolean(),
      immediateResultDisplay: z.boolean(),
      negativeMarking: z.boolean(),
    })
    .refine((v) => v.lateLoginCutoffMins >= v.lateLoginGraceMins, {
      message: 'Late-login cutoff must be at least the grace period.',
      path: ['lateLoginCutoffMins'],
    }),
  notifications: z.object({
    emailEnabled: z.boolean(),
    smtpHost: z.string().trim().max(255),
    smsAlertsEnabled: z.boolean(),
    inAppBanners: z.boolean(),
    criticalHealthAlerts: z.boolean(),
    studentDisconnectAlerts: z.boolean(),
    officerApprovalAlerts: z.boolean(),
    examDeadlineReminders: z.boolean(),
  }),
  data: z.object({
    autoDailyBackup: z.boolean(),
    backupTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm (24-hour).'),
    retentionDays: z.number().int().min(7).max(3650),
  }),
} as const;

export type SettingGroup = keyof typeof settingSchemas;
export type Settings = { [K in SettingGroup]: z.infer<(typeof settingSchemas)[K]> };

export const SETTING_DEFAULTS: Settings = {
  general: {
    platformName: 'LASUSTECH Computer Based Testing (CBT) Portal',
    institutionShort: 'LASUSTECH',
    timezone: 'Africa/Lagos',
    defaultSession: '',
    supportPhone: '',
    liveExamMode: true,
    maintenanceMode: false,
  },
  security: {
    twoFactorStaff: false,
    sessionTimeoutMins: 30,
    maxLoginAttempts: 5,
    lockoutDurationMins: 15,
    passwordExpiryDays: 90,
    enforceSingleSession: true,
    cbtSubnets: [],
  },
  exam: {
    autosaveSeconds: 3,
    heartbeatSeconds: 10,
    disconnectClockPolicy: 'RUNNING',
    autoSubmitOnExpiry: true,
    lateLoginGraceMins: 15,
    lateLoginCutoffMins: 30,
    tabSwitchLimit: 2,
    antiCheatEnabled: true,
    shuffleQuestions: true,
    shuffleOptions: true,
    immediateResultDisplay: false,
    negativeMarking: false,
  },
  notifications: {
    emailEnabled: false,
    smtpHost: '',
    smsAlertsEnabled: false,
    inAppBanners: true,
    criticalHealthAlerts: true,
    studentDisconnectAlerts: true,
    officerApprovalAlerts: true,
    examDeadlineReminders: true,
  },
  data: { autoDailyBackup: true, backupTime: '02:00', retentionDays: 90 },
};

const cache = new Map<SettingGroup, { at: number; value: unknown }>();
const TTL_MS = 15_000;

export async function getGroup<K extends SettingGroup>(group: K): Promise<Settings[K]> {
  const hit = cache.get(group);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Settings[K];
  const row = await prisma.setting.findUnique({ where: { key: group } });
  const stored = (row?.value as Record<string, unknown> | undefined) ?? {};
  const parsed = settingSchemas[group].safeParse({ ...SETTING_DEFAULTS[group], ...stored });
  const value = (parsed.success ? parsed.data : SETTING_DEFAULTS[group]) as Settings[K];
  cache.set(group, { at: Date.now(), value });
  return value;
}

export async function getAll(): Promise<Settings> {
  const groups = Object.keys(settingSchemas) as SettingGroup[];
  const entries = await Promise.all(groups.map(async (g) => [g, await getGroup(g)] as const));
  return Object.fromEntries(entries) as Settings;
}

export const invalidateSettings = () => cache.clear();
export const ROLES = ['super_admin', 'tenant_admin', 'tenant_user'] as const;
export type Role = (typeof ROLES)[number];

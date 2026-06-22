/* eslint-disable camelcase */
// Allow auth_type='graph' on smtp_configs so Microsoft Graph HTTP send can be used
// instead of SMTP-AUTH (which Exchange Online can block per-mailbox or per-tenant).
exports.up = (pgm) => {
  pgm.sql("ALTER TABLE smtp_configs DROP CONSTRAINT smtp_configs_auth_type_check");
  pgm.addConstraint('smtp_configs', 'smtp_configs_auth_type_check', { check: "auth_type IN ('password','xoauth2','graph')" });
};
exports.down = (pgm) => {
  pgm.sql("UPDATE smtp_configs SET auth_type='xoauth2' WHERE auth_type='graph'");
  pgm.sql("ALTER TABLE smtp_configs DROP CONSTRAINT smtp_configs_auth_type_check");
  pgm.addConstraint('smtp_configs', 'smtp_configs_auth_type_check', { check: "auth_type IN ('password','xoauth2')" });
};

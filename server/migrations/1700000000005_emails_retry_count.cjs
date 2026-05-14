/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.addColumns('emails', {
    retry_count: { type: 'int', notNull: true, default: 0 },
    updated_at:  { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // Trigger to keep updated_at fresh
  pgm.sql(`
    CREATE OR REPLACE FUNCTION emails_set_updated_at() RETURNS trigger AS $$
    BEGIN NEW.updated_at = now(); RETURN NEW; END
    $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    CREATE TRIGGER emails_updated_at
    BEFORE UPDATE ON emails
    FOR EACH ROW EXECUTE FUNCTION emails_set_updated_at();
  `);
};
exports.down = (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS emails_updated_at ON emails');
  pgm.sql('DROP FUNCTION IF EXISTS emails_set_updated_at');
  pgm.dropColumns('emails', ['retry_count', 'updated_at']);
};

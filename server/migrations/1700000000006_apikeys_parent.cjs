/* eslint-disable camelcase */
exports.up = (pgm) => {
  // Sub-keys: parent_id NULL => top-level ("master") key; set => sub-key of that master.
  // Self-referential FK; deleting a parent cascades to its sub-keys.
  pgm.addColumn('api_keys', {
    parent_id: { type: 'uuid', references: 'api_keys(id)', onDelete: 'CASCADE' },
  });
  pgm.createIndex('api_keys', ['parent_id']);
};
exports.down = (pgm) => {
  pgm.dropColumn('api_keys', 'parent_id');
};

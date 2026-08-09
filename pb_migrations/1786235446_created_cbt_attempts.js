/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = new Collection({
    "createRule": "@request.auth.collectionName = 'students' && student_auth_id = @request.auth.id",
    "deleteRule": "@request.auth.collectionName = 'admins'",
    "fields": [
      {
        "autogeneratePattern": "[a-z0-9]{15}",
        "help": "",
        "hidden": false,
        "id": "text3208210256",
        "max": 15,
        "min": 15,
        "name": "id",
        "pattern": "^[a-z0-9]+$",
        "presentable": false,
        "primaryKey": true,
        "required": true,
        "system": true,
        "type": "text"
      },
      {
        "autogeneratePattern": "",
        "help": "",
        "hidden": false,
        "id": "text509412441",
        "max": 0,
        "min": 0,
        "name": "test_id",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": true,
        "system": false,
        "type": "text"
      },
      {
        "autogeneratePattern": "",
        "help": "",
        "hidden": false,
        "id": "text1840526436",
        "max": 0,
        "min": 0,
        "name": "student_auth_id",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": true,
        "system": false,
        "type": "text"
      },
      {
        "autogeneratePattern": "",
        "help": "",
        "hidden": false,
        "id": "text1627391454",
        "max": 0,
        "min": 0,
        "name": "student_name",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": false,
        "system": false,
        "type": "text"
      },
      {
        "autogeneratePattern": "",
        "help": "",
        "hidden": false,
        "id": "text3932047689",
        "max": 0,
        "min": 0,
        "name": "class_name",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": false,
        "system": false,
        "type": "text"
      },
      {
        "autogeneratePattern": "",
        "help": "",
        "hidden": false,
        "id": "text4224597626",
        "max": 0,
        "min": 0,
        "name": "subject",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": false,
        "system": false,
        "type": "text"
      },
      {
        "autogeneratePattern": "",
        "help": "",
        "hidden": false,
        "id": "text2769282957",
        "max": 0,
        "min": 0,
        "name": "term",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": false,
        "system": false,
        "type": "text"
      },
      {
        "help": "",
        "hidden": false,
        "id": "json1355859462",
        "maxSize": 0,
        "name": "answers",
        "presentable": false,
        "required": false,
        "system": false,
        "type": "json"
      },
      {
        "help": "",
        "hidden": false,
        "id": "number848901969",
        "max": null,
        "min": null,
        "name": "score",
        "onlyInt": false,
        "presentable": false,
        "required": false,
        "system": false,
        "type": "number"
      },
      {
        "help": "",
        "hidden": false,
        "id": "number906242243",
        "max": null,
        "min": null,
        "name": "total_questions",
        "onlyInt": false,
        "presentable": false,
        "required": false,
        "system": false,
        "type": "number"
      }
    ],
    "id": "pbc_4086661152",
    "indexes": [
      "CREATE UNIQUE INDEX idx_cbt_attempts_unique ON cbt_attempts (test_id, student_auth_id)",
      "CREATE INDEX idx_cbt_attempts_class ON cbt_attempts (class_name)"
    ],
    "listRule": "@request.auth.collectionName = 'admins' || @request.auth.collectionName = 'staff' || student_auth_id = @request.auth.id",
    "name": "cbt_attempts",
    "system": false,
    "type": "base",
    "updateRule": null,
    "viewRule": "@request.auth.collectionName = 'admins' || @request.auth.collectionName = 'staff' || student_auth_id = @request.auth.id"
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_4086661152");

  return app.delete(collection);
})

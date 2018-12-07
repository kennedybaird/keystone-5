const pluralize = require('pluralize');

const {
  resolveAllKeys,
  mapKeys,
  omit,
  unique,
  intersection,
  mergeWhereClause,
  objMerge,
  arrayToObject,
  flatten,
  createLazyDeferred,
} = require('@voussoir/utils');

const { parseListAccess } = require('@voussoir/access-control');

const logger = require('@voussoir/logger');

const { Text, Checkbox, Float, Relationship } = require('@voussoir/fields');

const graphqlLogger = logger('graphql');
const keystoneLogger = logger('keystone');

const { AccessDeniedError, ValidationFailureError } = require('./graphqlErrors');

const upcase = str => str.substr(0, 1).toUpperCase() + str.substr(1);

const keyToLabel = str =>
  str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/\s|_|\-/)
    .filter(i => i)
    .map(upcase)
    .join(' ');

const labelToPath = str =>
  str
    .split(' ')
    .join('-')
    .toLowerCase();

const labelToClass = str => str.replace(/\s+/g, '');

const nativeTypeMap = new Map([
  [
    Boolean,
    {
      name: 'Boolean',
      keystoneType: Checkbox,
    },
  ],
  [
    String,
    {
      name: 'String',
      keystoneType: Text,
    },
  ],
  [
    Number,
    {
      name: 'Number',
      keystoneType: Float,
    },
  ],
]);

const opToType = {
  read: 'query',
  create: 'mutation',
  update: 'mutation',
  delete: 'mutation',
};

const mapNativeTypeToKeystonType = (type, listKey, fieldPath) => {
  if (!nativeTypeMap.has(type)) {
    return type;
  }

  const { name, keystoneType } = nativeTypeMap.get(type);

  keystoneLogger.warn(
    { nativeType: type, keystoneType, listKey, fieldPath },
    `Mapped field ${listKey}.${fieldPath} from native JavaScript type '${name}', to '${
      keystoneType.type.type
    }' from the @voussoir/fields package.`
  );

  return keystoneType;
};

module.exports = class List {
  constructor(key, config, { getListByKey, adapter, defaultAccess, getAuth }) {
    this.key = key;

    // 180814 JM TODO: Since there's no access control specified, this implicitly makes name, id or {labelField} readable by all (probably bad?)
    config.adminConfig = {
      defaultPageSize: 50,
      defaultColumns: Object.keys(config.fields)
        .slice(0, 2)
        .join(','),
      defaultSort: Object.keys(config.fields)[0],
      maximumPageSize: 1000,
      ...(config.adminConfig || {}),
    };
    this.config = {
      labelResolver: item => item[config.labelField || 'name'] || item.id,
      hooks: {},
      ...config,
    };

    this.getListByKey = getListByKey;
    this.defaultAccess = defaultAccess;
    this.getAuth = getAuth;

    const label = keyToLabel(key);
    const singular = pluralize.singular(label);
    const plural = pluralize.plural(label);

    if (plural === label) {
      throw new Error(
        `Unable to use ${label} as a List name - it has an ambiguous plural (${plural}). Please choose another name for your list.`
      );
    }

    this.adminUILabels = {
      label: config.label || plural,
      singular: config.singular || singular,
      plural: config.plural || plural,
      path: config.path || labelToPath(plural),
    };

    const itemQueryName = config.itemQueryName || labelToClass(singular);
    const listQueryName = config.listQueryName || labelToClass(plural);

    this.gqlNames = {
      outputTypeName: this.key,
      itemQueryName: itemQueryName,
      listQueryName: `all${listQueryName}`,
      listQueryMetaName: `_all${listQueryName}Meta`,
      listMetaName: `_${listQueryName}Meta`,
      authenticatedQueryName: `authenticated${itemQueryName}`,
      deleteMutationName: `delete${itemQueryName}`,
      deleteManyMutationName: `delete${listQueryName}`,
      updateMutationName: `update${itemQueryName}`,
      createMutationName: `create${itemQueryName}`,
      whereInputName: `${itemQueryName}WhereInput`,
      whereUniqueInputName: `${itemQueryName}WhereUniqueInput`,
      updateInputName: `${itemQueryName}UpdateInput`,
      createInputName: `${itemQueryName}CreateInput`,
      relateToManyInputName: `${itemQueryName}RelateToManyInput`,
      relateToOneInputName: `${itemQueryName}RelateToOneInput`,
    };

    this.adapter = adapter.newListAdapter(this.key, this.config);

    this.access = parseListAccess({
      listKey: key,
      access: config.access,
      defaultAccess: this.defaultAccess.list,
    });

    const sanitisedFieldsConfig = mapKeys(config.fields, (fieldConfig, path) => {
      return {
        ...fieldConfig,
        type: mapNativeTypeToKeystonType(fieldConfig.type, key, path),
      };
    });

    this.fieldsByPath = {};
    this.fields = Object.keys(sanitisedFieldsConfig).map(path => {
      const { type, ...fieldSpec } = sanitisedFieldsConfig[path];
      const implementation = type.implementation;
      this.fieldsByPath[path] = new implementation(path, fieldSpec, {
        getListByKey,
        listKey: key,
        listAdapter: this.adapter,
        fieldAdapterClass: type.adapters[adapter.name],
        defaultAccess: this.defaultAccess.field,
      });
      return this.fieldsByPath[path];
    });

    this.adapter.prepareModel();

    this.views = mapKeys(sanitisedFieldsConfig, fieldConfig => ({
      ...fieldConfig.type.views,
    }));
  }

  getAdminMeta() {
    return {
      key: this.key,
      // Reduce to truthy values (functions can't be passed over the webpack
      // boundary)
      access: mapKeys(this.access, val => !!val),
      label: this.adminUILabels.label,
      singular: this.adminUILabels.singular,
      plural: this.adminUILabels.plural,
      path: this.adminUILabels.path,
      gqlNames: this.gqlNames,
      fields: this.fields.filter(field => field.access.read).map(field => field.getAdminMeta()),
      views: this.views,
      adminConfig: {
        defaultPageSize: this.config.adminConfig.defaultPageSize,
        defaultColumns: this.config.adminConfig.defaultColumns.replace(/\s/g, ''), // remove all whitespace
        defaultSort: this.config.adminConfig.defaultSort,
        maximumPageSize: Math.max(
          this.config.adminConfig.defaultPageSize,
          this.config.adminConfig.maximumPageSize
        ),
      },
    };
  }
  get gqlTypes() {
    // https://github.com/opencrud/opencrud/blob/master/spec/2-relational/2-2-queries/2-2-3-filters.md#boolean-expressions
    const types = [];
    if (this.access.read || this.access.create || this.access.update || this.access.delete) {
      types.push(
        ...flatten(this.fields.map(field => field.gqlAuxTypes)),
        `
        type ${this.gqlNames.outputTypeName} {
          id: ID
          """
          This virtual field will be resolved in one of the following ways (in this order):
           1. Execution of 'labelResolver' set on the ${this.key} List config, or
           2. As an alias to the field set on 'labelField' in the ${this.key} List config, or
           3. As an alias to a 'name' field on the ${this.key} List (if one exists), or
           4. As an alias to the 'id' field on the ${this.key} List.
          """
          _label_: String
          ${flatten(
            this.fields
              .filter(field => field.access.read) // If it's globally set to false, makes sense to never show it
              .map(field => field.gqlOutputFields)
          ).join('\n')}
        }
      `,
        `
        input ${this.gqlNames.whereInputName} {
          id: ID
          id_not: ID
          id_in: [ID!]
          id_not_in: [ID!]

          AND: [${this.gqlNames.whereInputName}]
          OR: [${this.gqlNames.whereInputName}]

          ${flatten(
            this.fields
              .filter(field => field.access.read) // If it's globally set to false, makes sense to never show it
              .map(field => field.gqlQueryInputFields)
          ).join('\n')}
        }`,
        // TODO: Include other `unique` fields and allow filtering by them
        `
        input ${this.gqlNames.whereUniqueInputName} {
          id: ID!
        }`
      );
    }

    if (this.access.update) {
      types.push(`
        input ${this.gqlNames.updateInputName} {
          ${flatten(
            this.fields
              .filter(field => field.access.update) // If it's globally set to false, makes sense to never let it be updated
              .map(field => field.gqlUpdateInputFields)
          ).join('\n')}
        }
      `);
    }

    if (this.access.create) {
      types.push(`
        input ${this.gqlNames.createInputName} {
          ${flatten(
            this.fields
              .filter(field => field.access.create) // If it's globally set to false, makes sense to never let it be created
              .map(field => field.gqlCreateInputFields)
          ).join('\n')}
        }
      `);
    }

    return types;
  }

  getGraphqlFilterFragment() {
    return [
      `where: ${this.gqlNames.whereInputName}`,
      `search: String`,
      `orderBy: String`,
      `first: Int`,
      `skip: Int`,
    ];
  }

  get gqlQueries() {
    // All the auxiliary queries the fields want to add
    const queries = flatten(this.fields.map(field => field.gqlAuxQueries));

    // If `read` is either `true`, or a function (we don't care what the result
    // of the function is, that'll get executed at a later time)
    if (this.access.read) {
      queries.push(
        `
        ${this.gqlNames.listQueryName}(
          ${this.getGraphqlFilterFragment().join('\n')}
        ): [${this.gqlNames.outputTypeName}]`,

        `${this.gqlNames.itemQueryName}(
          where: ${this.gqlNames.whereUniqueInputName}!
        ): ${this.gqlNames.outputTypeName}`,

        `${this.gqlNames.listQueryMetaName}(
          ${this.getGraphqlFilterFragment().join('\n')}
        ): _QueryMeta`,

        `${this.gqlNames.listMetaName}: _ListMeta`
      );
    }

    if (this.getAuth()) {
      // If auth is enabled for this list (doesn't matter what strategy)
      queries.push(`${this.gqlNames.authenticatedQueryName}: ${this.gqlNames.outputTypeName}`);
    }

    return queries;
  }

  getFieldsRelatedTo(listKey) {
    return this.fields.filter(
      ({ isRelationship, refListKey }) => isRelationship && refListKey === listKey
    );
  }

  _throwAccessDenied(operation, context, target, extraInternalData = {}, extraData = {}) {
    throw new AccessDeniedError({
      data: {
        type: opToType[operation],
        target,
        ...extraData,
      },
      internalData: {
        authedId: context.authedItem && context.authedItem.id,
        authedListKey: context.authedListKey,
        ...extraInternalData,
      },
    });
  }

  // Wrap the "inner" resolver for a single output field with an access control check
  wrapFieldResolverWithAC(field, innerResolver) {
    return (item, args, context, ...rest) => {
      // If not allowed access
      const operation = 'read';
      const access = context.getFieldAccessControlForUser(this.key, field.path, item, operation);
      if (!access) {
        // If the client handles errors correctly, it should be able to
        // receive partial data (for the fields the user has access to),
        // and then an `errors` array of AccessDeniedError's
        this._throwAccessDenied(operation, context, field.path, { itemId: item ? item.id : null });
      }

      // Otherwise, execute the original/inner resolver
      return innerResolver(item, args, context, ...rest);
    };
  }

  get gqlFieldResolvers() {
    if (!this.access.read) {
      return {};
    }
    const fieldResolvers = {
      // TODO: The `_label_` output field currently circumvents access control
      _label_: this.config.labelResolver,
      ...objMerge(
        this.fields
          .filter(field => field.access.read)
          .map(field =>
            // Get the resolvers for the (possibly multiple) output fields and wrap each with access control
            mapKeys(field.gqlOutputFieldResolvers, innerResolver =>
              this.wrapFieldResolverWithAC(field, innerResolver)
            )
          )
      ),
    };
    return { [this.gqlNames.outputTypeName]: fieldResolvers };
  }

  get gqlAuxFieldResolvers() {
    // TODO: Obey the same ACL rules based on parent type
    return objMerge(this.fields.map(field => field.gqlAuxFieldResolvers));
  }
  get gqlAuxQueryResolvers() {
    // TODO: Obey the same ACL rules based on parent type
    return objMerge(this.fields.map(field => field.gqlAuxQueryResolvers));
  }
  get gqlAuxMutationResolvers() {
    // TODO: Obey the same ACL rules based on parent type
    return objMerge(this.fields.map(field => field.gqlAuxMutationResolvers));
  }

  get gqlMutations() {
    const mutations = flatten(this.fields.map(field => field.gqlAuxMutations));

    // NOTE: We only check for truthy as it could be `true`, or a function (the
    // function is executed later in the resolver)
    if (this.access.create) {
      mutations.push(`
        ${this.gqlNames.createMutationName}(
          data: ${this.gqlNames.createInputName}
        ): ${this.gqlNames.outputTypeName}
      `);
    }

    if (this.access.update) {
      mutations.push(`
        ${this.gqlNames.updateMutationName}(
          id: ID!
          data: ${this.gqlNames.updateInputName}
        ): ${this.gqlNames.outputTypeName}
      `);
    }

    if (this.access.delete) {
      mutations.push(`
        ${this.gqlNames.deleteMutationName}(
          id: ID!
        ): ${this.gqlNames.outputTypeName}
      `);

      mutations.push(`
        ${this.gqlNames.deleteManyMutationName}(
          ids: [ID!]
        ): [${this.gqlNames.outputTypeName}]
      `);
    }

    return mutations;
  }

  checkFieldAccess(operation, existingItem, data, context, { gqlName, extraData = {} }) {
    const restrictedFields = [];

    this.fields
      .filter(field => field.path in data)
      .forEach(field => {
        const access = context.getFieldAccessControlForUser(
          this.key,
          field.path,
          existingItem,
          operation
        );
        if (!access) {
          restrictedFields.push(field.path);
        }
      });

    if (restrictedFields.length) {
      this._throwAccessDenied(operation, context, gqlName, extraData, { restrictedFields });
    }
  }

  checkListAccess(context, operation, { gqlName, ...extraInternalData }) {
    const access = context.getListAccessControlForUser(this.key, operation);
    if (!access) {
      graphqlLogger.debug(
        { operation, access, gqlName, ...extraInternalData },
        'Access statically or implicitly denied'
      );
      graphqlLogger.info({ operation, gqlName, ...extraInternalData }, 'Access Denied');
      // If the client handles errors correctly, it should be able to
      // receive partial data (for the fields the user has access to),
      // and then an `errors` array of AccessDeniedError's
      this._throwAccessDenied(operation, context, gqlName, extraInternalData);
    }
    return access;
  }

  async getAccessControlledItem(id, access, { context, operation, gqlName }) {
    const throwAccessDenied = msg => {
      graphqlLogger.debug({ id, operation, access, gqlName }, msg);
      graphqlLogger.info({ id, operation, gqlName }, 'Access Denied');
      // If the client handles errors correctly, it should be able to
      // receive partial data (for the fields the user has access to),
      // and then an `errors` array of AccessDeniedError's
      this._throwAccessDenied(operation, context, gqlName, { itemId: id });
    };

    let item;
    // Early out - the user has full access to update this list
    if (access === true) {
      item = await this.adapter.findById(id);
    } else if (
      (access.id && access.id !== id) ||
      (access.id_not && access.id_not === id) ||
      (access.id_in && !access.id_in.includes(id)) ||
      (access.id_not_in && access.id_not_in.includes(id))
    ) {
      // It's odd, but conceivable the access control specifies a single id
      // the user has access to. So we have to do a check here to see if the
      // ID they're requesting matches that ID.
      // Nice side-effect: We can throw without having to ever query the DB.
      // NOTE: Don't try to early out here by doing
      // if(access.id === id) return findById(id)
      // this will result in a possible false match if a declarative access
      // control clause has other items in it
      throwAccessDenied('Item excluded this id from filters');
    } else {
      // NOTE: The fields will be filtered by the ACL checking in gqlFieldResolvers()
      // We only want 1 item, don't make the DB do extra work
      // NOTE: Order in where: { ... } doesn't matter, if `access.id !== id`, it will
      // have been caught earlier, so this spread and overwrite can only
      // ever be additive or overwrite with the same value
      item = (await this.adapter.itemsQuery({ first: 1, where: { ...access, id } }))[0];
    }
    if (!item) {
      // Throwing an AccessDenied here if the item isn't found because we're
      // strict about accidentally leaking information (that the item doesn't
      // exist)
      // NOTE: There is a potential security risk here if we were to
      // further check the existence of an item with the given ID: It'd be
      // possible to figure out if records with particular IDs exist in
      // the DB even if the user doesn't have access (eg; check a bunch of
      // IDs, and the ones that return AccessDenied exist, and the ones
      // that return null do not exist). Similar to how S3 returns 403's
      // always instead of ever returning 404's.
      // Our version is to always throw if not found.
      throwAccessDenied('Zero items found');
    }
    // Found the item, and it passed the filter test
    return item;
  }

  async getAccessControlledItems(ids, access) {
    if (ids.length === 0) {
      return [];
    }

    const uniqueIds = unique(ids);

    // Early out - the user has full access to operate on this list
    if (access === true) {
      return await this.adapter.itemsQuery({ where: { id_in: uniqueIds } });
    }

    let idFilters = {};

    if (access.id || access.id_in) {
      const accessControlIdsAllowed = unique([].concat(access.id, access.id_in).filter(id => id));

      idFilters.id_in = intersection(accessControlIdsAllowed, uniqueIds);
    } else {
      idFilters.id_in = uniqueIds;
    }

    if (access.id_not || access.id_not_in) {
      const accessControlIdsDisallowed = unique(
        [].concat(access.id_not, access.id_not_in).filter(id => id)
      );

      idFilters.id_not_in = intersection(accessControlIdsDisallowed, uniqueIds);
    }

    // It's odd, but conceivable the access control specifies a single id
    // the user has access to. So we have to do a check here to see if the
    // ID they're requesting matches that ID.
    // Nice side-effect: We can throw without having to ever query the DB.
    // NOTE: Don't try to early out here by doing
    // if(access.id === id) return findById(id)
    // this will result in a possible false match if the access control
    // has other items in it
    if (
      // Only some ids are allowed, and none of them have been passed in
      (idFilters.id_in && idFilters.id_in.length === 0) ||
      // All the passed in ids have been explicitly disallowed
      (idFilters.id_not_in && idFilters.id_not_in.length === uniqueIds.length)
    ) {
      // NOTE: We don't throw an error for multi-actions, only return an empty
      // array because there's no mechanism in GraphQL to return more than one
      // error for a list result.
      return [];
    }

    // NOTE: The fields will be filtered by the ACL checking in gqlFieldResolvers()
    // NOTE: Unlike in the single-operation variation, there is no security risk
    // in returning the result of the query here, because if no items match, we
    // return an empty array regarless of if that's because of lack of
    // permissions or because of those items don't exist.
    const remainingAccess = omit(access, ['id', 'id_not', 'id_in', 'id_not_in']);
    return await this.adapter.itemsQuery({ where: { ...remainingAccess, ...idFilters } });
  }

  get gqlQueryResolvers() {
    let resolvers = {};

    // If set to false, we can confidently remove these resolvers entirely from
    // the graphql schema
    if (this.access.read) {
      resolvers = {
        [this.gqlNames.listQueryName]: (_, args, context) =>
          this.listQuery(args, context, this.gqlNames.listQueryName),

        [this.gqlNames.listQueryMetaName]: (_, args, context) =>
          this.listQueryMeta(args, context, this.gqlNames.listQueryMetaName),

        [this.gqlNames.listMetaName]: (_, args, context) => this.listMeta(context),

        [this.gqlNames.itemQueryName]: (_, { where: { id } }, context) =>
          this.itemQuery(id, context, this.gqlNames.itemQueryName),
      };
    }

    // NOTE: This query is not effected by the read permissions; if the user can
    // authenticate themselves, then they already have access to know that the
    // list exists
    if (this.getAuth()) {
      resolvers[this.gqlNames.authenticatedQueryName] = (_, __, context) =>
        this.authenticatedQuery(context);
    }

    return resolvers;
  }

  async listQuery(args, context, queryName) {
    const access = this.checkListAccess(context, 'read', { queryName });

    return this.adapter.itemsQuery(mergeWhereClause(args, access));
  }

  async listQueryMeta(args, context, queryName) {
    return {
      // Return these as functions so they're lazily evaluated depending
      // on what the user requested
      // Evalutation takes place in ../Keystone/index.js
      getCount: () => {
        const access = this.checkListAccess(context, 'read', { queryName });

        return this.adapter
          .itemsQueryMeta(mergeWhereClause(args, access))
          .then(({ count }) => count);
      },
    };
  }

  listMeta(context) {
    return {
      name: this.key,
      // Return these as functions so they're lazily evaluated depending
      // on what the user requested
      // Evalutation takes place in ../Keystone/index.js
      // NOTE: These could return a Boolean or a JSON object (if using the
      // declarative syntax)
      getAccess: () => ({
        getCreate: () => context.getListAccessControlForUser(this.key, 'create'),
        getRead: () => context.getListAccessControlForUser(this.key, 'read'),
        getUpdate: () => context.getListAccessControlForUser(this.key, 'update'),
        getDelete: () => context.getListAccessControlForUser(this.key, 'delete'),
      }),
      getSchema: () => {
        const queries = [
          this.gqlNames.itemQueryName,
          this.gqlNames.listQueryName,
          this.gqlNames.listQueryMetaName,
        ];

        if (this.getAuth()) {
          queries.push(this.gqlNames.authenticatedQueryName);
        }

        // NOTE: Other fields on this type are resolved in the main resolver in
        // ../Keystone/index.js
        return {
          type: this.gqlNames.outputTypeName,
          queries,
          key: this.key,
        };
      },
    };
  }

  async itemQuery(id, context, gqlName) {
    const operation = 'read';
    graphqlLogger.debug({ id, operation, type: opToType[operation], gqlName }, 'Start query');

    const access = this.checkListAccess(context, operation, { gqlName, itemId: id });

    const result = await this.getAccessControlledItem(id, access, { context, operation, gqlName });

    graphqlLogger.debug({ id, operation, type: opToType[operation], gqlName }, 'End query');
    return result;
  }

  authenticatedQuery(context) {
    if (!context.authedItem || context.authedListKey !== this.key) {
      return null;
    }

    return this.itemQuery(context.authedItem.id, context, this.gqlNames.authenticatedQueryName);
  }

  get gqlMutationResolvers() {
    const mutationResolvers = {};

    if (this.access.create) {
      mutationResolvers[this.gqlNames.createMutationName] = (_, { data }, context) =>
        this.createMutation(data, context);
    }

    if (this.access.update) {
      mutationResolvers[this.gqlNames.updateMutationName] = async (_, { id, data }, context) =>
        this.updateMutation(id, data, context);
    }

    if (this.access.delete) {
      mutationResolvers[this.gqlNames.deleteMutationName] = async (_, { id }, context) =>
        this.deleteMutation(id, context);

      mutationResolvers[this.gqlNames.deleteManyMutationName] = async (_, { ids }, context) =>
        this.deleteManyMutation(ids, context);
    }

    return mutationResolvers;
  }

  _throwValidationFailure(errors, operation, data = {}) {
    throw new ValidationFailureError({
      data: {
        messages: errors.map(e => e.msg),
        errors: errors.map(e => e.data),
        listKey: this.key,
        operation,
      },
      internalData: {
        errors: errors.map(e => e.internalData),
        data,
      },
    });
  }

  async _mapToFields(fields, action) {
    return await resolveAllKeys(arrayToObject(fields, 'path', action));
  }

  _fieldsFromObject(obj) {
    return Object.keys(obj)
      .map(fieldPath => this.fieldsByPath[fieldPath])
      .filter(field => field);
  }

  async _resolveRelationship(data, existingItem, context, getItem, mutationState) {
    const fields = this._fieldsFromObject(data).filter(field => field.isRelationship);
    return {
      ...data,
      ...(await this._mapToFields(fields, async field =>
        field.resolveRelationship(data[field.path], existingItem, context, getItem, mutationState)
      )),
    };
  }

  async _registerBacklinks(existingItem, mutationState) {
    const fields = this.fields.filter(field => field.isRelationship);
    await this._mapToFields(fields, field =>
      field.registerBacklink(existingItem[field.path], existingItem, mutationState)
    );
  }

  async _resolveDefaults(data) {
    // FIXME: Consider doing this in a way which only calls getDefaultValue once.
    const fields = this.fields.filter(field => field.getDefaultValue() !== undefined);
    return {
      ...(await this._mapToFields(fields, field => field.getDefaultValue())),
      ...data,
    };
  }

  async _resolveInput(resolvedData, existingItem, context, operation, originalInput) {
    const args = { resolvedData, existingItem, context, adapter: this.adapter, originalInput };
    const fields = this._fieldsFromObject(resolvedData);

    resolvedData = await this._mapToFields(fields, field =>
      field.resolveInput({ resolvedData, ...args })
    );
    resolvedData = {
      ...resolvedData,
      ...(await this._mapToFields(fields.filter(field => field.config.hooks.resolveInput), field =>
        field.config.hooks.resolveInput({ resolvedData, ...args })
      )),
    };

    if (this.config.hooks.resolveInput) {
      resolvedData = await this.config.hooks.resolveInput({ resolvedData, ...args });
    }

    return resolvedData;
  }

  async _validateInput(resolvedData, existingItem, context, operation, originalInput) {
    const args = { resolvedData, existingItem, context, adapter: this.adapter, originalInput };
    const fields = this._fieldsFromObject(resolvedData);
    this._validateHook(args, fields, operation, 'validateInput');
  }

  async _validateDelete(existingItem, context, operation) {
    const args = { existingItem, context, adapter: this.adapter };
    const fields = this.fields;
    this._validateHook(args, fields, operation, 'validateDelete');
  }

  async _validateHook(args, fields, operation, hookName) {
    const { originalInput } = args;
    const fieldValidationErrors = [];
    // FIXME: Can we do this in a way where we simply return validation errors instead?
    args.addFieldValidationError = (msg, _data = {}, internalData = {}) =>
      fieldValidationErrors.push({ msg, data: _data, internalData });
    await this._mapToFields(fields, field => field[hookName](args));
    await this._mapToFields(fields.filter(field => field.config.hooks[hookName]), field =>
      field.config.hooks[hookName](args)
    );
    if (fieldValidationErrors.length) {
      this._throwValidationFailure(fieldValidationErrors, operation, originalInput);
    }

    if (this.config.hooks[hookName]) {
      const listValidationErrors = [];
      await this.config.hooks[hookName]({
        ...args,
        addValidationError: (msg, _data = {}, internalData = {}) =>
          listValidationErrors.push({ msg, data: _data, internalData }),
      });
      if (listValidationErrors.length) {
        this._throwValidationFailure(listValidationErrors, operation, originalInput);
      }
    }
  }

  async _beforeChange(resolvedData, existingItem, context, originalInput) {
    const args = { resolvedData, existingItem, context, adapter: this.adapter, originalInput };
    this._runHook(args, resolvedData, 'beforeChange');
  }

  async _beforeDelete(existingItem, context) {
    const args = { existingItem, context, adapter: this.adapter };
    this._runHook(args, existingItem, 'beforeDelete');
  }

  async _afterChange(updatedItem, existingItem, context, originalInput) {
    const args = { updatedItem, originalInput, existingItem, context, adapter: this.adapter };
    this._runHook(args, originalInput, 'afterChange');
  }

  async _afterDelete(existingItem, context) {
    const args = { existingItem, context, adapter: this.adapter };
    this._runHook(args, existingItem, 'afterDelete');
  }

  async _runHook(args, fieldObject, hookName) {
    const fields = this._fieldsFromObject(fieldObject);
    await this._mapToFields(fields, field => field[hookName](args));
    await this._mapToFields(fields.filter(field => field.config.hooks[hookName]), field =>
      field.config.hooks[hookName](args)
    );

    if (this.config.hooks[hookName]) await this.config.hooks[hookName](args);
  }

  async _nestedMutation(mutationState, context, mutation) {
    // Set up a fresh mutation state if we're the root mutation
    const isRootMutation = !mutationState;
    if (isRootMutation) {
      mutationState = { afterChangeStack: [], queues: {} };
    }

    // Perform the mutation
    const { result, afterHook } = await mutation(mutationState);

    // resolve backlinks
    await Relationship.resolveBacklinks(context, mutationState);

    // Push after-hook onto the stack and resolve all if we're the root.
    const { afterChangeStack } = mutationState;
    afterChangeStack.push(afterHook);
    if (isRootMutation) {
      while (afterChangeStack.length) {
        await afterChangeStack.pop()();
      }
    }

    // Return the result of the mutation
    return result;
  }

  async createMutation(data, context, mutationState) {
    const operation = 'create';
    const gqlName = this.gqlNames.createMutationName;

    this.checkListAccess(context, operation, { gqlName });

    const existingItem = undefined;

    this.checkFieldAccess(operation, existingItem, data, context, { gqlName });

    return await this._nestedMutation(mutationState, context, async mutationState => {
      const defaultedItem = await this._resolveDefaults(data);

      // Enable resolveRelationship to perform some action after the item is created by
      // giving them a promise which will eventually resolve with the value of the
      // newly created item.
      const createdPromise = createLazyDeferred();

      let resolvedData = await this._resolveRelationship(
        defaultedItem,
        existingItem,
        context,
        createdPromise.promise,
        mutationState
      );

      resolvedData = await this._resolveInput(resolvedData, existingItem, context, operation, data);

      await this._validateInput(resolvedData, existingItem, context, operation, data);

      await this._beforeChange(resolvedData, existingItem, context, operation, data);

      let newItem;
      try {
        newItem = await this.adapter.create(resolvedData);
        createdPromise.resolve(newItem);
        // Wait until next tick so the promise/micro-task queue can be flushed
        // fully, ensuring the deferred handlers get executed before we move on
        await new Promise(res => process.nextTick(res));
      } catch (error) {
        createdPromise.reject(error);
        // Wait until next tick so the promise/micro-task queue can be flushed
        // fully, ensuring the deferred handlers get executed before we move on
        await new Promise(res => process.nextTick(res));
        // Rethrow the error to ensure it's surfaced to Apollo
        throw error;
      }

      return {
        result: newItem,
        afterHook: () => this._afterChange(newItem, existingItem, context, operation, data),
      };
    });
  }

  async updateMutation(id, data, context, mutationState) {
    const operation = 'update';
    const gqlName = this.gqlNames.updateMutationName;
    const extraData = { itemId: id };

    const access = this.checkListAccess(context, operation, { gqlName, ...extraData });

    const existingItem = await this.getAccessControlledItem(id, access, {
      context,
      operation,
      gqlName,
    });

    this.checkFieldAccess(operation, existingItem, data, context, { gqlName, extraData });

    return await this._nestedMutation(mutationState, context, async mutationState => {
      let resolvedData = await this._resolveRelationship(
        data,
        existingItem,
        context,
        undefined,
        mutationState
      );

      resolvedData = await this._resolveInput(resolvedData, existingItem, context, operation, data);

      await this._validateInput(resolvedData, existingItem, context, operation, data);

      await this._beforeChange(resolvedData, existingItem, context, operation, data);

      const newItem = await this.adapter.update(id, resolvedData);

      return {
        result: newItem,
        afterHook: () => this._afterChange(newItem, existingItem, context, operation, data),
      };
    });
  }

  async deleteMutation(id, context, mutationState) {
    const operation = 'delete';
    const gqlName = this.gqlNames.deleteMutationName;

    const access = this.checkListAccess(context, operation, { gqlName, itemId: id });

    const existingItem = await this.getAccessControlledItem(id, access, {
      context,
      operation,
      gqlName,
    });

    return this._deleteWithFieldHooks(existingItem, context, mutationState);
  }

  async deleteManyMutation(ids, context, mutationState) {
    const operation = 'delete';
    const gqlName = this.gqlNames.deleteManyMutationName;

    const access = this.checkListAccess(context, operation, { gqlName, itemIds: ids });

    const existingItems = await this.getAccessControlledItems(ids, access);

    return Promise.all(
      existingItems.map(async existingItem =>
        this._deleteWithFieldHooks(existingItem, context, mutationState)
      )
    );
  }

  async _deleteWithFieldHooks(existingItem, context, mutationState) {
    const operation = 'delete';

    return await this._nestedMutation(mutationState, context, async mutationState => {
      await this._registerBacklinks(existingItem, mutationState);

      await this._validateDelete(existingItem, context, operation);

      await this._beforeDelete(existingItem, context);

      const result = await this.adapter.delete(existingItem.id);

      return {
        result,
        afterHook: () => this._afterDelete(existingItem, context),
      };
    });
  }

  getFieldByPath(path) {
    return this.fieldsByPath[path];
  }
};

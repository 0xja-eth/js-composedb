import type { BaseQuery, QueryFilters, Sorting } from '@ceramicnetwork/common'
import type { ModelInstanceDocument } from '@ceramicnetwork/stream-model-instance'
import { CeramicCommitID, getScalar } from '@composedb/graphql-scalars'
import type {
  RuntimeCompositeDefinition,
  RuntimeList,
  RuntimeModel,
  RuntimeObjectField,
  RuntimeObjectFields,
  RuntimeReference,
  RuntimeReferenceType,
  RuntimeRelation,
  RuntimeScalar,
  RuntimeScalarCommon,
  RuntimeViewField,
  RuntimeViewReference,
} from '@composedb/types'
import {
  GraphQLBoolean,
  GraphQLEnumType,
  type GraphQLEnumValueConfigMap,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
  GraphQLFloat,
  type GraphQLInputFieldConfigMap,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  assertValidSchema,
  GraphQLArgumentConfig,
} from 'graphql'
import {
  type Connection,
  type ConnectionArguments,
  connectionArgs,
  connectionDefinitions,
  mutationWithClientMutationId,
  nodeDefinitions,
} from 'graphql-relay'

import type { Context } from './context.js'
import type { UpdateDocOptions } from './loader.js'
import { assertValidQueryFilters, createRelationQueryFilters } from './query.js'
import { ObjMap } from 'graphql/jsutils/ObjMap'

const NON_SCALAR_FIELD_TYPES: Array<RuntimeObjectField['type']> = [
  'meta',
  'reference',
  'list',
  'view',
]
function isScalarField(field: RuntimeObjectField): field is RuntimeScalar {
  return !NON_SCALAR_FIELD_TYPES.includes(field.type)
}

const STRING_REFERENCE_TYPES: Array<RuntimeReferenceType> = ['enum', 'node']
function isStringReferenceField(field: RuntimeObjectField): field is RuntimeReference {
  return field.type === 'reference' && STRING_REFERENCE_TYPES.includes(field.refType)
}

type EmbeddedObject = { __type: string; [key: string]: unknown }

type GraphQLNodeDefinitions = {
  nodeInterface: GraphQLInterfaceType
  nodeField: GraphQLFieldConfig<unknown, Context>
  nodesField: GraphQLFieldConfig<unknown, Context>
}
type SharedDefinitions = GraphQLNodeDefinitions & {
  accountObject: GraphQLObjectType<string, Context>
  queryFields: GraphQLFieldConfigMap<unknown, Context>
}

type BuildObjectParams = {
  name: string
  fields: RuntimeObjectFields
  definitions: SharedDefinitions
}
type BuildDocumentObjectParams = BuildObjectParams & { model: RuntimeModel }

type ConnectionAccountArgument = { account?: string }
type ConnectionFiltersArgument = { filters?: QueryFilters }
type ConnectionSortingArgument = { sorting?: Sorting }

type ConnectionQueryArguments = ConnectionArguments &
  ConnectionFiltersArgument &
  ConnectionSortingArgument
type ConnectionRelationArguments = ConnectionQueryArguments & ConnectionAccountArgument
type ConnectionRelationCountArguments = ConnectionAccountArgument & ConnectionFiltersArgument

function createAccountReferenceQuery(
  modelID: string,
  account: string,
  reference: RuntimeViewReference,
  filters?: QueryFilters,
): BaseQuery {
  const query: BaseQuery = { model: modelID }
  if (reference.type === 'account') {
    // Current account is referenced in a document field
    query.queryFilters = createRelationQueryFilters(reference.property, account, filters)
  } else {
    // Current account is the controller of the document
    query.account = account
    if (filters != null) {
      assertValidQueryFilters(filters)
      query.queryFilters = filters
    }
  }
  return query
}

const connectionArgsWithAccount = {
  ...connectionArgs,
  account: {
    type: GraphQLID,
    description: 'Returns only documents created by the provided account',
  },
}

const SetOptionsInput = new GraphQLInputObjectType({
  name: 'SetOptionsInput',
  fields: {
    syncTimeout: {
      type: GraphQLInt,
      description:
        'Maximum amount of time to lookup the stream over the network, in seconds - see https://developers.ceramic.network/reference/typescript/interfaces/_ceramicnetwork_common.CreateOpts.html#syncTimeoutSeconds',
    },
  },
})

type SetOptions = {
  syncTimeout?: number
}

const UpdateOptionsInput = new GraphQLInputObjectType({
  name: 'UpdateOptionsInput',
  fields: {
    replace: {
      type: GraphQLBoolean,
      defaultValue: false,
      description: 'Fully replace the document contents instead of performing a shallow merge',
    },
    version: {
      type: CeramicCommitID,
      description: 'Only perform mutation if the document matches the provided version',
    },
  },
})

const SortOrder = new GraphQLEnumType({
  name: 'SortOrder',
  values: {
    ASC: { value: 'ASC' },
    DESC: { value: 'DESC' },
  },
})

function createEnumValueFilterInput(type: GraphQLEnumType): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name: `${type.name}ValueFilterInput`,
    fields: {
      isNull: { type: GraphQLBoolean },
      equalTo: { type },
      notEqualTo: { type },
      in: { type: new GraphQLList(new GraphQLNonNull(type)) },
      notIn: { type: new GraphQLList(new GraphQLNonNull(type)) },
    },
  })
}

function createScalarValueFilterInput(type: GraphQLScalarType): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name: `${type.name}ValueFilterInput`,
    fields: {
      isNull: { type: GraphQLBoolean },
      equalTo: { type },
      notEqualTo: { type },
      in: { type: new GraphQLList(new GraphQLNonNull(type)) },
      notIn: { type: new GraphQLList(new GraphQLNonNull(type)) },
      lessThan: { type },
      lessThanOrEqualTo: { type },
      greaterThan: { type },
      greaterThanOrEqualTo: { type },
    },
  })
}

const valueFilterInputs = {
  BooleanValueFilter: new GraphQLInputObjectType({
    name: 'BooleanValueFilterInput',
    fields: {
      isNull: { type: GraphQLBoolean },
      equalTo: { type: GraphQLBoolean },
    },
  }),
  FloatValueFilter: createScalarValueFilterInput(GraphQLFloat),
  IntValueFilter: createScalarValueFilterInput(GraphQLInt),
  StringValueFilter: createScalarValueFilterInput(GraphQLString),
} as const
const valueFilterInputsTypes: Record<string, string> = {
  boolean: 'BooleanValueFilter',
  float: 'FloatValueFilter',
  integer: 'IntValueFilter',
  string: 'StringValueFilter',
}

/**
 * GraphQL schema creation parameters.
 */
export type CreateSchemaParams = {
  /**
   * Runtime composite definition, created using the {@linkcode devtools.Composite Composite}
   * development tools.
   */
  definition: RuntimeCompositeDefinition
  /**
   * Set the schema to read-only, disabling mutations support.
   */
  readonly?: boolean
}

class SchemaBuilder {
  // Source composite
  #def: RuntimeCompositeDefinition
  // Schema options
  #isReadonly: boolean
  // Internal records
  #types: Record<string, GraphQLEnumType | GraphQLObjectType> = { SortOrder }
  #inputObjects: Record<string, GraphQLInputObjectType> = { ...valueFilterInputs }
  #mutations: Record<string, GraphQLFieldConfig<any, Context>> = {}
  // Internal mapping of model IDs to object names
  #modelAliases: Record<string, string>

  constructor(params: CreateSchemaParams) {
    this.#def = params.definition
    this.#isReadonly = !!params.readonly
    this.#modelAliases = Object.entries(this.#def.models).reduce(
      (aliases, [alias, model]) => {
        aliases[model.id] = alias
        return aliases
      },
      {} as Record<string, string>,
    )
  }

  build(): GraphQLSchema {
    this._buildEnums()
    const definitions = this._createSharedDefinitions()
    this._buildObjects(definitions)
    this._buildConnections()
    const schema = this._createSchema(definitions)
    assertValidSchema(schema)
    return schema
  }

  _createSharedDefinitions(): SharedDefinitions {
    const nodeDefs = nodeDefinitions(
      async (id: string, ctx: Context) => {
        return id.startsWith('did:') ? id : await ctx.loadDoc(id)
      },
      (didOrDoc: string | ModelInstanceDocument) => {
        return typeof didOrDoc === 'string'
          ? 'CeramicAccount'
          : this.#modelAliases[didOrDoc.metadata.model?.toString()]
      },
    )

    const accountObject = new GraphQLObjectType<string, Context>({
      name: 'CeramicAccount',
      interfaces: [nodeDefs.nodeInterface],
      fields: () => {
        const config: GraphQLFieldConfigMap<string, Context> = {
          id: {
            type: new GraphQLNonNull(GraphQLID),
            description: 'Globally unique identifier of the account (DID string)',
            resolve: (did) => did,
          },
          isViewer: {
            type: new GraphQLNonNull(GraphQLBoolean),
            description:
              'Whether the Ceramic instance is currently authenticated with this account or not',
            resolve: (did, _, ctx) => ctx.isAuthenticated() && ctx.getViewerID() === did,
          },
        }
        for (const [alias, reference] of Object.entries(this.#def.accountData ?? {})) {
          const model = this.#def.models[reference.name]
          if (model == null) {
            throw new Error(`Missing model for reference name: ${reference.name}`)
          }

          if (reference.type === 'node') {
            config[alias] = {
              type: this.#types[reference.name],
              resolve: async (account, _, ctx): Promise<ModelInstanceDocument | null> => {
                return await ctx.querySingle({ account, model: model.id })
              },
            }
          } else if (reference.type === 'account' || reference.type === 'connection') {
            const filtersObj = this.#inputObjects[`${reference.name}Filters`]
            const sortingObj = this.#inputObjects[`${reference.name}Sorting`]
            const args: ObjMap<GraphQLArgumentConfig> = {
              ...connectionArgs,
            }
            if (filtersObj && sortingObj) {
              args.filters = { type: filtersObj }
              args.sorting = { type: sortingObj }
            }
            config[alias] = {
              type: this.#types[`${reference.name}Connection`],
              args,
              resolve: async (
                account,
                { filters, ...args }: ConnectionQueryArguments,
                ctx,
              ): Promise<Connection<ModelInstanceDocument | null>> => {
                const query = createAccountReferenceQuery(model.id, account, reference, filters)
                return await ctx.queryConnection({ ...query, ...args })
              },
            }
            config[`${alias}Count`] = {
              type: new GraphQLNonNull(GraphQLInt),
              args: filtersObj ? { filters: { type: filtersObj } } : {},
              resolve: async (
                account,
                { filters }: ConnectionFiltersArgument,
                ctx,
              ): Promise<number> => {
                const query = createAccountReferenceQuery(model.id, account, reference, filters)
                return await ctx.queryCount(query)
              },
            }
          } else {
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            throw new Error(`Unsupported reference type: ${reference.type}`)
          }
        }
        return config
      },
    })

    const queryFields: GraphQLFieldConfigMap<unknown, Context> = {
      node: nodeDefs.nodeField,
      viewer: {
        type: accountObject,
        description: 'Account currently authenticated on the Ceramic instance, if set',
        resolve: (_self, _args, ctx): string | null => ctx.getViewerID(),
      },
    }

    return { ...nodeDefs, accountObject, queryFields }
  }

  _buildEnums() {
    for (const [name, values] of Object.entries(this.#def.enums)) {
      this.#types[name] = new GraphQLEnumType({
        name,
        values: values.reduce((acc, value) => {
          acc[value] = { value }
          return acc
        }, {} as GraphQLEnumValueConfigMap),
      })
    }
  }

  _buildObjects(definitions: SharedDefinitions) {
    for (const [name, fields] of Object.entries(this.#def.objects)) {
      this._buildObjectType({ definitions, name, fields })
    }
  }

  _buildObjectType(params: BuildObjectParams) {
    const model = this.#def.models[params.name]
    return model
      ? this._buildDocumentObjectType({ model, ...params })
      : this._buildEmbeddedObjectType(params)
  }

  _buildDocumentObjectType({ model, definitions, name, fields }: BuildDocumentObjectParams) {
    this.#types[name] = new GraphQLObjectType<ModelInstanceDocument>({
      name,
      interfaces: [definitions.nodeInterface],
      isTypeOf: (value: ModelInstanceDocument) => {
        return value.metadata.model.toString() === model.id
      },
      fields: () => {
        const config: GraphQLFieldConfigMap<ModelInstanceDocument, Context> = {
          id: {
            // Use GraphQLID here for Relay compliance
            type: new GraphQLNonNull(GraphQLID),
            resolve: (doc) => doc.id.toString(),
          },
        }
        for (const [key, field] of Object.entries(fields)) {
          switch (field.type) {
            case 'meta':
              // Don't show meta fields in schema
              continue
            case 'reference':
              config[key] = this._buildDocumentObjectReferenceField(key, field)
              break
            case 'list':
              config[key] = {
                type: this._buildObjectListFieldType(definitions, field),
                resolve: (doc) => doc.content?.[key] as unknown,
              }
              break
            case 'view': {
              const view = this._buildDocumentObjectViewField(key, definitions, field, fields)
              if (view) {
                config[key] = view
              }
              break
            }
            default:
              config[key] = {
                type: this._buildScalarFieldType(definitions, field),
                resolve: (doc) => doc.content?.[key] as unknown,
              }
          }
        }
        return config
      },
    })

    this._buildFiltersType(name, fields)
    this._buildSortingType(name, fields)

    if (!this.#isReadonly) {
      this._buildInputObjectType(name, fields)
      this._buildNodeMutations(definitions.queryFields, name, model)
    }
  }

  _buildEmbeddedObjectType({ definitions, name, fields }: BuildObjectParams) {
    this.#types[name] = new GraphQLObjectType<EmbeddedObject>({
      name,
      fields: () => {
        const config: GraphQLFieldConfigMap<EmbeddedObject, Context> = {}
        for (const [key, field] of Object.entries(fields)) {
          switch (field.type) {
            case 'meta':
              // Don't show meta fields in schema
              continue
            case 'reference':
              config[key] = this._buildEmbeddedObjectReferenceField(key, field)
              break
            case 'list':
              config[key] = {
                type: this._buildObjectListFieldType(definitions, field),
                resolve: (obj) => obj[key],
              }
              break
            case 'view':
              throw new Error(`Unsupported view field ${key} on embedded object ${name}`)
            default:
              config[key] = {
                type: this._buildScalarFieldType(definitions, field),
                resolve: (obj) => obj[key],
              }
          }
        }
        return config
      },
    })

    if (!this.#isReadonly) {
      this._buildInputObjectType(name, fields)
    }
  }

  _buildConnections() {
    for (const objectName of Object.keys(this.#def.models)) {
      const nodeType = this.#types[objectName]
      if (nodeType == null) {
        throw new Error(`Missing object type for connection: ${objectName}`)
      }
      const { connectionType, edgeType } = connectionDefinitions({ nodeType })
      this.#types[`${objectName}Connection`] = connectionType
      this.#types[`${objectName}Edge`] = edgeType
    }
  }

  _buildDocumentObjectReferenceField(
    key: string,
    field: RuntimeReference,
  ): GraphQLFieldConfig<ModelInstanceDocument, Context> {
    const name = field.refType === 'connection' ? field.refName + 'Connection' : field.refName
    const ref = this.#types[name]
    if (ref == null) {
      throw new Error(`Missing type: ${name}`)
    }
    const type = field.required ? new GraphQLNonNull(ref) : ref

    switch (field.refType) {
      case 'connection':
        return {
          type,
          args: connectionArgs,
          resolve: (_doc, _args: ConnectionArguments, _ctx): Promise<Connection<any> | null> => {
            throw new Error('Not implemented')
          },
        }
      case 'node':
        return {
          type,
          args: connectionArgs,
          resolve: async (doc, _, ctx): Promise<ModelInstanceDocument | null> => {
            return await ctx.loadDoc(doc.content[key] as string)
          },
        }
      case 'enum':
      case 'object':
        return { type, resolve: (doc) => doc.content[key] as unknown }
      default:
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw new Error(`Unsupported reference type on document object: ${field.refType}`)
    }
  }

  _buildEmbeddedObjectReferenceField(
    key: string,
    field: RuntimeReference,
  ): GraphQLFieldConfig<EmbeddedObject, Context> {
    const ref = this.#types[field.refName]
    if (ref == null) {
      throw new Error(`Missing type: ${field.refName}`)
    }
    const type = field.required ? new GraphQLNonNull(ref) : ref

    switch (field.refType) {
      case 'enum':
      case 'object':
        return { type, resolve: (obj) => obj[key] }
      default:
        throw new Error(`Unsupported reference type on embedded object: ${field.refType}`)
    }
  }

  _buildObjectListFieldType(
    definitions: SharedDefinitions,
    field: RuntimeList,
  ): GraphQLList<GraphQLOutputType> | GraphQLNonNull<GraphQLList<GraphQLOutputType>> {
    let itemType
    if (field.item.type === 'reference') {
      itemType = this.#types[field.item.refName]
      if (itemType == null) {
        throw new Error(`Missing referenced object type: ${field.item.refName}`)
      }
    } else if (field.item.type === 'did') {
      itemType = definitions.accountObject
    } else {
      itemType = getScalar(field.item.type)
    }

    if (field.item.required) {
      itemType = new GraphQLNonNull(itemType)
    }

    const type = new GraphQLList(itemType)
    return field.required ? new GraphQLNonNull(type) : type
  }

  _buildDocumentObjectRelation(
    key: string,
    relation: RuntimeRelation,
    objectFields: RuntimeObjectFields,
  ): GraphQLFieldConfig<ModelInstanceDocument, Context> {
    const modelAlias = this.#modelAliases[relation.model]
    if (modelAlias == null) {
      throw new Error(
        `Model alias not found for relation with ID ${relation.model} on field ${key}`,
      )
    }

    switch (relation.source) {
      case 'document': {
        const ref = objectFields[relation.property]
        if (ref == null) {
          throw new Error(
            `Missing reference field ${relation.property} for relation defined on field ${key}`,
          )
        }
        return {
          type: this.#types[modelAlias],
          resolve: async (doc, _args, ctx): Promise<ModelInstanceDocument | null> => {
            const id = doc.content?.[relation.property] as string | void
            if (id == null) {
              return null
            }
            const loaded = await ctx.loadDoc(id)
            if (loaded == null) {
              return null
            }
            const loadedModel = loaded.metadata.model.toString()
            if (relation.model != null && loadedModel !== relation.model) {
              console.warn(
                `Ignoring unexpected model ${loadedModel} for document ${id}, expected model ${relation.model}`,
              )
              return null
            }
            return loaded
          },
        }
      }
      case 'queryConnection': {
        const qcFiltersObj = this.#inputObjects[`${modelAlias}Filters`]
        const qcSortingObj = this.#inputObjects[`${modelAlias}Sorting`]
        const args: ObjMap<GraphQLArgumentConfig> = {
          ...connectionArgsWithAccount,
        }
        if (qcFiltersObj && qcSortingObj) {
          args.filters = { type: qcFiltersObj }
          args.sorting = { type: qcSortingObj }
        }
        return {
          type: new GraphQLNonNull(this.#types[`${modelAlias}Connection`]),
          args,
          resolve: async (
            doc,
            args: ConnectionRelationArguments,
            ctx,
          ): Promise<Connection<unknown> | null> => {
            const account =
              args.account === 'documentAccount' ? doc.metadata.controller : args.account
            const queryFilters = createRelationQueryFilters(
              relation.property,
              doc.id.toString(),
              args.filters,
            )
            return await ctx.queryConnection({
              ...args,
              account,
              model: relation.model,
              queryFilters,
            })
          },
        }
      }
      case 'queryCount': {
        const filtersObj = this.#inputObjects[`${modelAlias}Filters`]
        const args: ObjMap<GraphQLArgumentConfig> = {
          account: {
            type: GraphQLID,
            description: 'Counts only documents created by the provided account',
          },
        }
        if (filtersObj) {
          args.filters = { type: filtersObj }
        }
        return {
          type: new GraphQLNonNull(GraphQLInt),
          args,
          resolve: async (doc, args: ConnectionRelationCountArguments, ctx): Promise<number> => {
            const account =
              args.account === 'documentAccount' ? doc.metadata.controller : args.account
            const queryFilters = createRelationQueryFilters(
              relation.property,
              doc.id.toString(),
              args.filters,
            )
            return await ctx.queryCount({ account, model: relation.model, queryFilters })
          },
        }
      }
      default:
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw new Error(`Unsupported relation source: ${relation.source}`)
    }
  }

  _buildDocumentObjectViewField(
    key: string,
    definitions: SharedDefinitions,
    field: RuntimeViewField,
    objectFields: RuntimeObjectFields,
  ): GraphQLFieldConfig<ModelInstanceDocument, Context> {
    switch (field.viewType) {
      case 'documentAccount':
        return {
          type: new GraphQLNonNull(definitions.accountObject),
          description: 'Account controlling the document',
          resolve: (doc): string => doc.metadata.controller,
        }
      case 'documentVersion':
        return {
          type: new GraphQLNonNull(CeramicCommitID),
          description: 'Current version of the document',
          resolve: (doc): string => doc.commitId.toString(),
        }
      case 'relation':
        return this._buildDocumentObjectRelation(key, field.relation, objectFields)
      default:
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw new Error(`Unsupported view type: ${field.viewType}`)
    }
  }

  _buildScalarFieldType(definitions: SharedDefinitions, field: RuntimeScalar): GraphQLOutputType {
    const type = field.type === 'did' ? definitions.accountObject : getScalar(field.type)
    return field.required ? new GraphQLNonNull(type) : type
  }

  _buildFiltersType(objectName: string, fields: RuntimeObjectFields) {
    const objectInputName = `${objectName}ObjectFilter`
    const inputName = `${objectName}Filters`

    const config: GraphQLInputFieldConfigMap = {}
    for (const [key, field] of Object.entries(fields)) {
      let type: GraphQLInputObjectType | undefined
      if (field.type === 'reference' && (field as RuntimeReference).indexed) {
        if (field.refType === 'enum') {
          const enumType = this.#types[field.refName] as GraphQLEnumType
          type = createEnumValueFilterInput(enumType)
          this.#inputObjects[type.name] = type
        } else if (field.refType === 'node') {
          type = this.#inputObjects.StringValueFilter
        }
      } else if (isScalarField(field) && (field as RuntimeScalarCommon).indexed) {
        type = this.#inputObjects[valueFilterInputsTypes[field.type] ?? 'StringValueFilter']
      }
      if (type != null) {
        config[key] = { type }
      }
    }

    if (Object.keys(config).length > 0) {
      this.#inputObjects[objectInputName] = new GraphQLInputObjectType({
        name: `${objectInputName}Input`,
        fields: () => config,
      })

      this.#inputObjects[inputName] = new GraphQLInputObjectType({
        name: `${inputName}Input`,
        fields: () => ({
          where: { type: this.#inputObjects[objectInputName] },
          and: { type: new GraphQLList(new GraphQLNonNull(this.#inputObjects[inputName])) },
          or: { type: new GraphQLList(new GraphQLNonNull(this.#inputObjects[inputName])) },
          not: { type: this.#inputObjects[inputName] },
        }),
      })
    }
  }

  _buildSortingType(objectName: string, fields: RuntimeObjectFields) {
    const name = `${objectName}Sorting`
    const config: GraphQLInputFieldConfigMap = {}
    for (const [key, field] of Object.entries(fields)) {
      if (
        (isStringReferenceField(field) || isScalarField(field)) &&
        (field as RuntimeScalarCommon).indexed
      ) {
        config[key] = { type: SortOrder }
      }
    }
    if (Object.keys(config).length > 0) {
      this.#inputObjects[name] = new GraphQLInputObjectType({
        name: `${name}Input`,
        fields: () => config,
      })
    }
  }

  _buildInputObjectType(name: string, fields: RuntimeObjectFields) {
    const isDocument = this.#def.models[name] != null

    const buildFields = (required: boolean): GraphQLInputFieldConfigMap => {
      const config: GraphQLInputFieldConfigMap = {}
      const inputPrefix = isDocument || required ? '' : 'Partial'

      for (const [key, field] of Object.entries(fields)) {
        let type
        switch (field.type) {
          case 'meta':
          case 'view':
            // Meta and views can't be set in inputs
            continue
          case 'reference':
            switch (field.refType) {
              case 'connection':
                // Ignore connections from inputs, should be derived
                continue
              case 'enum':
                type = this.#types[field.refName] as GraphQLEnumType
                break
              case 'node':
                type = GraphQLID
                break
              case 'object': {
                type = this.#inputObjects[inputPrefix + field.refName]
                if (type == null) {
                  throw new Error(`Missing referenced input type: ${inputPrefix + field.refName}`)
                }
                break
              }
            }
            break
          case 'list': {
            let itemType
            if (field.item.type === 'reference') {
              itemType = this.#inputObjects[inputPrefix + field.item.refName]
              if (itemType == null) {
                throw new Error(
                  `Missing referenced input type: ${inputPrefix + field.item.refName}`,
                )
              }
            } else {
              itemType = getScalar(field.item.type)
            }
            type = new GraphQLList(itemType)
            break
          }
          default:
            type = getScalar(field.type)
        }
        if (type != null) {
          config[key] = { type: required && field.required ? new GraphQLNonNull(type) : type }
        }
      }

      return config
    }

    this.#inputObjects[name] = new GraphQLInputObjectType({
      name: `${name}Input`,
      fields: () => buildFields(true),
    })
    if (isDocument) {
      this.#inputObjects[`Partial${name}`] = new GraphQLInputObjectType({
        name: `Partial${name}Input`,
        fields: () => buildFields(false),
      })
    }
  }

  _buildNodeMutations(
    queryFields: GraphQLFieldConfigMap<unknown, Context>,
    name: string,
    model: RuntimeModel,
  ) {
    if (model.accountRelation.type === 'single') {
      this.#mutations[`create${name}`] = mutationWithClientMutationId({
        name: `Create${name}`,
        inputFields: () => ({
          content: { type: new GraphQLNonNull(this.#inputObjects[name]) },
          options: { type: SetOptionsInput },
        }),
        outputFields: () => ({
          ...queryFields,
          document: { type: new GraphQLNonNull(this.#types[name]) },
        }),
        mutateAndGetPayload: async (
          input: { content: Record<string, unknown>; options?: SetOptions },
          ctx: Context,
        ) => {
          if (ctx.ceramic.did == null || !ctx.ceramic.did.authenticated) {
            throw new Error('Ceramic instance is not authenticated')
          }
          const document = await ctx.createSingle(model.id, input.content, {
            syncTimeoutSeconds: input.options?.syncTimeout,
          })
          return { document }
        },
      })
    } else {
      this.#mutations[`create${name}`] = mutationWithClientMutationId({
        name: `Create${name}`,
        inputFields: () => ({
          content: { type: new GraphQLNonNull(this.#inputObjects[name]) },
        }),
        outputFields: () => ({
          ...queryFields,
          document: { type: new GraphQLNonNull(this.#types[name]) },
        }),
        mutateAndGetPayload: async (input: { content: Record<string, unknown> }, ctx: Context) => {
          if (ctx.ceramic.did == null || !ctx.ceramic.did.authenticated) {
            throw new Error('Ceramic instance is not authenticated')
          }
          const document = await ctx.createDoc(model.id, input.content)
          return { document }
        },
      })
    }

    this.#mutations[`update${name}`] = mutationWithClientMutationId({
      name: `Update${name}`,
      inputFields: () => ({
        id: { type: new GraphQLNonNull(GraphQLID) },
        content: { type: new GraphQLNonNull(this.#inputObjects[`Partial${name}`]) },
        options: { type: UpdateOptionsInput },
      }),
      outputFields: () => ({
        ...queryFields,
        document: { type: new GraphQLNonNull(this.#types[name]) },
      }),
      mutateAndGetPayload: async (
        input: { id: string; content: Record<string, unknown>; options?: UpdateDocOptions },
        ctx: Context,
      ) => {
        if (ctx.ceramic.did == null || !ctx.ceramic.did.authenticated) {
          throw new Error('Ceramic instance is not authenticated')
        }
        return { document: await ctx.updateDoc(input.id, input.content, input.options) }
      },
    })
  }

  _createSchema(definitions: SharedDefinitions) {
    const queryFields: GraphQLFieldConfigMap<unknown, Context> = {
      nodes: definitions.nodesField,
      ...definitions.queryFields,
    }

    for (const [alias, model] of Object.entries(this.#def.models)) {
      const first = alias[0].toLowerCase()
      const rest = alias.slice(1)

      const filtersObj = this.#inputObjects[`${alias}Filters`]
      const sortingObj = this.#inputObjects[`${alias}Sorting`]
      const args: ObjMap<GraphQLArgumentConfig> = {
        ...connectionArgs,
      }
      if (filtersObj && sortingObj) {
        args.filters = { type: filtersObj }
        args.sorting = { type: sortingObj }
      }
      queryFields[`${first}${rest}Index`] = {
        type: this.#types[`${alias}Connection`],
        args: args,
        resolve: async (
          _,
          { filters, ...args }: ConnectionQueryArguments,
          ctx,
        ): Promise<Connection<any> | null> => {
          if (filters != null) {
            assertValidQueryFilters(filters)
          }
          return await ctx.queryConnection({ ...args, queryFilters: filters, model: model.id })
        },
      }
      queryFields[`${first}${rest}Count`] = {
        type: new GraphQLNonNull(GraphQLInt),
        args: filtersObj ? { filters: { type: filtersObj } } : {},
        resolve: async (_, { filters }: ConnectionFiltersArgument, ctx): Promise<number> => {
          if (filters != null) {
            assertValidQueryFilters(filters)
          }
          return await ctx.queryCount({ queryFilters: filters, model: model.id })
        },
      }
    }

    const schemaFields: Record<string, GraphQLObjectType> = {
      query: new GraphQLObjectType({ name: 'Query', fields: queryFields }),
    }
    if (!this.#isReadonly && Object.keys(this.#mutations).length !== 0) {
      schemaFields.mutation = new GraphQLObjectType({ name: 'Mutation', fields: this.#mutations })
    }

    return new GraphQLSchema(schemaFields)
  }
}

/**
 * Create a GraphQL schema from a runtime composite definition
 */
export function createGraphQLSchema(params: CreateSchemaParams): GraphQLSchema {
  return new SchemaBuilder(params).build()
}

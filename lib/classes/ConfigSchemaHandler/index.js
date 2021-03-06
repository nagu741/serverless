'use strict';

const Ajv = require('ajv');
const _ = require('lodash');
const schema = require('../../configSchema');
const normalizeAjvErrors = require('./normalizeAjvErrors');

const FUNCTION_NAME_PATTERN = '^[a-zA-Z0-9-_]+$';
const ERROR_PREFIX = 'Configuration error';

class ConfigSchemaHandler {
  constructor(serverless) {
    this.serverless = serverless;
    this.schema = _.cloneDeep(schema);

    deepFreeze(this.schema.properties.service);
    deepFreeze(this.schema.properties.plugins);
    deepFreeze(this.schema.properties.package);
    Object.freeze(this.schema.properties.layers);
    Object.freeze(this.schema.properties.resources);
  }

  validateConfig(userConfig) {
    if (this.serverless.service.provider.name === 'aws') {
      // TODO: Remove after provider is fully covered, see https://github.com/serverless/serverless/issues/8022
      this.serverless.configSchemaHandler.relaxProviderSchema();
    }

    if (!this.schema.properties.provider.properties.name) {
      if (this.serverless.service.configValidationMode !== 'off') {
        this.serverless.cli.log(
          `Configuration error: Unrecognized provider '${this.serverless.service.provider.name}'`,
          'Serverless',
          { color: 'red' }
        );
        this.serverless.cli.log(
          "You're relying on provider plugin which doesn't " +
            'provide a validation schema for its config.',
          'Serverless',
          { color: 'grey' }
        );
        this.serverless.cli.log(
          'Please report the issue at its bug tracker linking: ' +
            'https://www.serverless.com/framework/docs/providers/aws/guide/plugins#extending-validation-schema',
          'Serverless',
          { color: 'grey' }
        );
        this.serverless.cli.log(
          'You may turn off this message with `configValidationMode: off` setting',
          'Serverless',
          { color: 'grey' }
        );
      }

      this.relaxProviderSchema();
    }

    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(this.schema);

    validate(userConfig);
    if (validate.errors) {
      const messages = normalizeAjvErrors(validate.errors, userConfig, this.schema).map(
        err => err.message
      );
      this.handleErrorMessages(messages);
    }
  }

  handleErrorMessages(messages) {
    if (messages.length) {
      if (this.serverless.service.configValidationMode === 'error') {
        const errorMessage =
          messages.length > 1
            ? `${ERROR_PREFIX}: \n     ${messages.join('\n     ')}`
            : `${ERROR_PREFIX} ${messages[0]}`;

        throw new this.serverless.classes.Error(errorMessage);
      } else {
        if (messages.length === 1) {
          this.serverless.cli.log(`${ERROR_PREFIX} ${messages[0]}`, 'Serverless', { color: 'red' });
        } else {
          this.serverless.cli.log(`${ERROR_PREFIX}:`, 'Serverless', { color: 'red' });
          for (const message of messages) {
            this.serverless.cli.log(`- ${message}`, 'Serverless', { color: 'red' });
          }
        }
        this.serverless.cli.log(
          'If you prefer to not continue when error in configuration is approached, ensure ' +
            '`configValidationMode: error` in your config',
          'Serverless',
          { color: 'grey' }
        );
        this.serverless.cli.log(
          'If errors are influenced by an external plugin, enquiry at plugin repository so ' +
            'schema extensions are added ' +
            '(https://www.serverless.com/framework/docs/providers/aws/guide/plugins#extending-validation-schema)',
          'Serverless',
          { color: 'grey' }
        );
        this.serverless.cli.log(
          'If errors seem invalid, please report at ' +
            'https://github.com/serverless/serverless/issues/new?template=bug_report.md',
          'Serverless',
          {
            color: 'grey',
          }
        );
        this.serverless.cli.log(
          'If you find this functionality problematic, you may turn it off with ' +
            '`configValidationMode: off` setting',
          'Serverless',
          { color: 'grey' }
        );
      }
    }
  }

  defineTopLevelProperty(name, subSchema) {
    this.schema.properties[name] = subSchema;
  }

  defineProvider(name, options = {}) {
    const currentProvider = this.serverless.service.provider.name;
    if (currentProvider !== name) {
      return;
    }

    this.schema.properties.provider.properties.name = { const: name };

    if (options.provider) {
      addPropertiesToSchema(this.schema.properties.provider, options.provider);
    }

    if (options.function) {
      addPropertiesToSchema(
        this.schema.properties.functions.patternProperties[FUNCTION_NAME_PATTERN],
        options.function
      );
    }

    if (options.functionEvents) {
      for (const functionName of Object.keys(options.functionEvents)) {
        this.defineFunctionEvent(name, functionName, options.functionEvents[functionName]);
      }
    }

    // In case provider implementers do not set stage or variableSyntax options,
    // then they are set here. The framework internally sets these options in
    // Service class.
    if (!this.schema.properties.provider.properties.stage) {
      addPropertiesToSchema(this.schema.properties.provider, {
        properties: { stage: { type: 'string' } },
      });
    }
    if (!this.schema.properties.provider.properties.variableSyntax) {
      addPropertiesToSchema(this.schema.properties.provider, {
        properties: { variableSyntax: { type: 'string' } },
      });
    }
  }

  defineCustomProperties(configSchemaParts) {
    addPropertiesToSchema(this.schema.properties.custom, configSchemaParts);
  }

  defineFunctionEvent(providerName, name, configSchema) {
    if (this.serverless.service.provider.name !== providerName) {
      return;
    }

    this.schema.properties.functions.patternProperties[
      FUNCTION_NAME_PATTERN
    ].properties.events.items.anyOf.push({
      type: 'object',
      properties: { [name]: configSchema },
      required: [name],
      additionalProperties: false,
    });
  }

  relaxProviderSchema() {
    this.schema.properties.provider.additionalProperties = true;
    this.schema.properties.functions.patternProperties[
      FUNCTION_NAME_PATTERN
    ].additionalProperties = true;

    // Do not report errors regarding unsupported function events as
    // their schemas are not defined.
    if (
      Array.isArray(
        this.schema.properties.functions.patternProperties[FUNCTION_NAME_PATTERN].properties.events
          .items.anyOf
      ) &&
      this.schema.properties.functions.patternProperties[FUNCTION_NAME_PATTERN].properties.events
        .items.anyOf.length === 1
    ) {
      this.schema.properties.functions.patternProperties[
        FUNCTION_NAME_PATTERN
      ].properties.events.items = {};
    }
  }
}

function addPropertiesToSchema(subSchema, extension = { properties: {}, required: [] }) {
  subSchema.properties = Object.assign(subSchema.properties, extension.properties);

  if (!subSchema.required) subSchema.required = [];

  if (Array.isArray(extension.required)) subSchema.required.push(...extension.required);
}

/*
 * Deep freezes an object. Stolen from
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/freeze
 */
function deepFreeze(object) {
  const propNames = Object.getOwnPropertyNames(object);
  for (const name of propNames) {
    const value = object[name];
    if (value && typeof value === 'object') {
      deepFreeze(value);
    }
  }
  return Object.freeze(object);
}

module.exports = ConfigSchemaHandler;

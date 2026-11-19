/**
 * Zero-dependency JSON Schema Draft 2020-12 subset validator.
 * Supports: type (single or union array), const, enum, pattern, minLength, maxLength,
 * minimum, maximum, required, properties, additionalProperties, items, minItems, uniqueItems.
 */

function getJsonType(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function matchesType(value, expectedType) {
  const actual = getJsonType(value);
  if (expectedType === "number") {
    return actual === "number" || actual === "integer";
  }
  return actual === expectedType;
}

function validateNode(value, schema, jsonPath, errors) {
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = allowed.some((t) => matchesType(value, t));
    if (!ok) {
      errors.push(`${jsonPath}: expected type ${allowed.join("|")}, got ${getJsonType(value)}`);
      return;
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${jsonPath}: expected constant ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  if (Array.isArray(schema.enum)) {
    const matched = schema.enum.some((opt) => opt === value);
    if (!matched) {
      errors.push(`${jsonPath}: value ${JSON.stringify(value)} not in enum [${schema.enum.join(", ")}]`);
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${jsonPath}: string length ${value.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${jsonPath}: string length ${value.length} > maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined) {
      const re = new RegExp(schema.pattern, "u");
      if (!re.test(value)) {
        errors.push(`${jsonPath}: "${value}" does not match pattern ${schema.pattern}`);
      }
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${jsonPath}: ${value} < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${jsonPath}: ${value} > maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${jsonPath}: array length ${value.length} < minItems ${schema.minItems}`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) {
        errors.push(`${jsonPath}: array items must be unique`);
      }
    }
    if (schema.items !== undefined) {
      for (let i = 0; i < value.length; i += 1) {
        validateNode(value[i], schema.items, `${jsonPath}[${i}]`, errors);
      }
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!Object.hasOwn(value, reqKey)) {
          errors.push(`${jsonPath}: missing required property "${reqKey}"`);
        }
      }
    }

    const props = schema.properties || {};
    for (const [key, propVal] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) {
        validateNode(propVal, props[key], `${jsonPath}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${jsonPath}: unexpected property "${key}" (additionalProperties: false)`);
      } else if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) {
        validateNode(propVal, schema.additionalProperties, `${jsonPath}.${key}`, errors);
      }
    }
  }
}

export function validateAgainstSchema(data, schema) {
  const errors = [];
  validateNode(data, schema, "$", errors);
  return {
    valid: errors.length === 0,
    errors,
  };
}

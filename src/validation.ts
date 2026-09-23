/**
 * identark/validation
 * ~~~~~~~~~~~~~~~~~~~
 * Input validation utilities for tool definitions and messages.
 */

import { ConfigurationError } from "./errors.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Validate tool definitions follow the OpenAI function calling schema.
 *
 * @throws ConfigurationError if tools are malformed.
 */
export function validateToolDefinitions(tools: unknown): void {
  if (tools === undefined || tools === null) {
    return;
  }

  if (!Array.isArray(tools)) {
    throw new ConfigurationError(`tools must be an array, got ${typeName(tools)}`);
  }

  tools.forEach((tool: unknown, i: number) => {
    if (!isPlainObject(tool)) {
      throw new ConfigurationError(`tools[${i}] must be an object, got ${typeName(tool)}`);
    }

    // Required: type field
    const toolType = tool.type;
    if (toolType === undefined || toolType === null) {
      throw new ConfigurationError(`tools[${i}] missing required 'type' field`);
    }
    if (toolType !== "function") {
      throw new ConfigurationError(`tools[${i}].type must be 'function', got '${String(toolType)}'`);
    }

    // Required: function field
    const func = tool.function;
    if (func === undefined || func === null) {
      throw new ConfigurationError(`tools[${i}] missing required 'function' field`);
    }
    if (!isPlainObject(func)) {
      throw new ConfigurationError(
        `tools[${i}].function must be an object, got ${typeName(func)}`,
      );
    }

    // Required: function.name
    const name = func.name;
    if (name === undefined || name === null) {
      throw new ConfigurationError(`tools[${i}].function missing required 'name' field`);
    }
    if (typeof name !== "string" || !name) {
      throw new ConfigurationError(`tools[${i}].function.name must be a non-empty string`);
    }

    // Optional but common: function.description
    if ("description" in func && typeof func.description !== "string") {
      throw new ConfigurationError(`tools[${i}].function.description must be a string`);
    }

    // Optional: function.parameters (JSON Schema). A missing 'type' is
    // tolerated — providers assume 'object'.
    const params = func.parameters;
    if (params !== undefined && params !== null && !isPlainObject(params)) {
      throw new ConfigurationError(
        `tools[${i}].function.parameters must be an object (JSON Schema)`,
      );
    }
  });
}

/**
 * Validate that a tool result is valid JSON.
 *
 * Warns but does not throw if content is not valid JSON.
 * Tool results should be JSON-serializable for best LLM understanding.
 */
export function validateToolResultJson(content: string, toolName: string): void {
  if (!content) {
    return;
  }

  try {
    JSON.parse(content);
  } catch {
    console.warn(
      `Tool result for '${toolName}' is not valid JSON. ` +
        "LLMs work best when tool results are JSON-formatted.",
    );
  }
}

/**
 * Validate message content structure.
 *
 * Content can be:
 * - string: Plain text
 * - array of objects: Multimodal content blocks (images, etc.)
 * - null/undefined: Empty content (valid for tool calls)
 *
 * @throws ConfigurationError if content is malformed.
 */
export function validateMessageContent(content: unknown): void {
  if (content === undefined || content === null || typeof content === "string") {
    return;
  }

  if (!Array.isArray(content)) {
    throw new ConfigurationError(
      `Message content must be string, array, or null, got ${typeName(content)}`,
    );
  }

  content.forEach((block: unknown, i: number) => {
    if (!isPlainObject(block)) {
      throw new ConfigurationError(
        `Message content[${i}] must be an object, got ${typeName(block)}`,
      );
    }
    if (!("type" in block)) {
      throw new ConfigurationError(`Message content[${i}] missing 'type' field`);
    }
  });
}

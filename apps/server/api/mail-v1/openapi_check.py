import re
from datetime import datetime

INTEGER = re.compile(r"-?[0-9]+")
DECIMAL = re.compile(r"-?[0-9]+\.[0-9]+")
ESCAPES = {'"': '"', "\\": "\\", "n": "\n"}
ANNOTATIONS = {"description", "title", "example", "examples", "default", "deprecated"}
KEYWORDS = {
    "$ref", "type", "properties", "required", "additionalProperties", "items", "enum", "const",
    "oneOf", "minimum", "minLength", "minItems", "maxItems", "pattern", "format",
}


class YamlError(ValueError):
    pass


def _quoted(text, start):
    index = start + 1
    out = []
    while index < len(text):
        char = text[index]
        if char == '"':
            return "".join(out), index + 1
        if char == "\\":
            index += 1
            if index >= len(text) or text[index] not in ESCAPES:
                raise YamlError(f"unsupported escape in {text!r}")
            out.append(ESCAPES[text[index]])
        else:
            out.append(char)
        index += 1
    raise YamlError(f"unterminated string in {text!r}")


def _split_flow(inner):
    parts = []
    current = []
    index = 0
    while index < len(inner):
        char = inner[index]
        if char == '"':
            _, end = _quoted(inner, index)
            current.append(inner[index:end])
            index = end
            continue
        if char in "[]{}":
            raise YamlError(f"nested flow collections are not supported: {inner!r}")
        if char == ",":
            parts.append("".join(current))
            current = []
        else:
            current.append(char)
        index += 1
    parts.append("".join(current))
    return parts


def _key_and_rest(content):
    if content.startswith('"'):
        key, end = _quoted(content, 0)
        remainder = content[end:]
        if not remainder.startswith(":") or remainder[1:2] not in ("", " "):
            raise YamlError(f"not a mapping line: {content!r}")
        return key, remainder[1:].strip()
    if content.endswith(":") and ": " not in content:
        return content[:-1], ""
    if ": " not in content:
        raise YamlError(f"not a mapping line: {content!r}")
    key, _, rest = content.partition(": ")
    if not key or key[0] in "[{&*!|>'%@`":
        raise YamlError(f"unsupported key: {content!r}")
    return key, rest.strip()


def _scalar(text):
    text = text.strip()
    if not text:
        raise YamlError("empty value")
    if text.startswith('"'):
        value, end = _quoted(text, 0)
        if text[end:].strip():
            raise YamlError(f"text after a string: {text!r}")
        return value
    if text.startswith("["):
        if not text.endswith("]"):
            raise YamlError(f"unterminated list: {text!r}")
        inner = text[1:-1]
        return [] if not inner.strip() else [_scalar(part) for part in _split_flow(inner)]
    if text.startswith("{"):
        if not text.endswith("}"):
            raise YamlError(f"unterminated map: {text!r}")
        inner = text[1:-1]
        result = {}
        for part in [] if not inner.strip() else _split_flow(inner):
            key, rest = _key_and_rest(part.strip())
            result[key] = _scalar(rest)
        return result
    if text == "true":
        return True
    if text == "false":
        return False
    if text == "null":
        return None
    if INTEGER.fullmatch(text):
        return int(text)
    if DECIMAL.fullmatch(text):
        return float(text)
    if text[0] in "&*!|>'%@`#" or " #" in text or ": " in text or text.endswith(":"):
        raise YamlError(f"unsupported plain text: {text!r}")
    return text


def _is_mapping_text(text):
    if text.startswith(("[", "{")):
        return False
    if text.startswith('"'):
        _, end = _quoted(text, 0)
        return text[end:].startswith(":")
    return ": " in text or text.endswith(":")


def _block(lines, index, indent):
    first = lines[index][1]
    if first == "-" or first.startswith("- "):
        return _sequence(lines, index, indent)
    return _mapping(lines, index, indent)


def _nested(lines, index, indent):
    if index < len(lines) and lines[index][0] > indent:
        return _block(lines, index, lines[index][0])
    return None, index


def _mapping(lines, index, indent):
    result = {}
    while index < len(lines) and lines[index][0] == indent:
        _, content, number = lines[index]
        if content == "-" or content.startswith("- "):
            raise YamlError(f"line {number}: a list item inside a map")
        key, rest = _key_and_rest(content)
        if key in result:
            raise YamlError(f"line {number}: repeated key {key!r}")
        index += 1
        if rest:
            result[key] = _scalar(rest)
        else:
            result[key], index = _nested(lines, index, indent)
    if index < len(lines) and lines[index][0] > indent:
        raise YamlError(f"line {lines[index][2]}: unexpected indent")
    return result, index


def _sequence(lines, index, indent):
    result = []
    while index < len(lines) and lines[index][0] == indent and (lines[index][1] == "-" or lines[index][1].startswith("- ")):
        content, number = lines[index][1], lines[index][2]
        rest = content[1:].strip()
        if not rest:
            index += 1
            value, index = _nested(lines, index, indent)
        elif _is_mapping_text(rest):
            lines[index] = [indent + 2, rest, number]
            value, index = _mapping(lines, index, indent + 2)
        else:
            value = _scalar(rest)
            index += 1
        result.append(value)
    if index < len(lines) and lines[index][0] > indent:
        raise YamlError(f"line {lines[index][2]}: unexpected indent")
    return result, index


def load(text):
    lines = []
    for number, raw in enumerate(text.split("\n"), start=1):
        if not raw.strip():
            continue
        if "\t" in raw:
            raise YamlError(f"line {number}: a tab")
        stripped = raw.lstrip(" ")
        if stripped.startswith("#"):
            raise YamlError(f"line {number}: comments are not supported")
        lines.append([len(raw) - len(stripped), stripped, number])
    if not lines:
        raise YamlError("empty document")
    value, index = _block(lines, 0, lines[0][0])
    if index != len(lines):
        raise YamlError(f"line {lines[index][2]}: unexpected content")
    return value


def _kind_ok(value, kind):
    if kind == "object":
        return isinstance(value, dict)
    if kind == "array":
        return isinstance(value, list)
    if kind == "string":
        return isinstance(value, str)
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if kind == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "null":
        return value is None
    raise ValueError(f"unsupported type {kind!r}")


def _same(left, right):
    return type(left) is type(right) and left == right


def _date_time(text):
    try:
        return datetime.fromisoformat(text).tzinfo is not None and "T" in text
    except ValueError:
        return False


class Validator:
    def __init__(self, document):
        self.root = document

    def resolve(self, ref):
        if not ref.startswith("#/"):
            raise ValueError(f"only local references are supported: {ref!r}")
        node = self.root
        for part in ref[2:].split("/"):
            node = node[part]
        return node

    def errors(self, value, schema, path="$"):
        if "$ref" in schema:
            extra = set(schema) - {"$ref"} - ANNOTATIONS
            if extra:
                raise ValueError(f"keywords next to $ref at {path}: {sorted(extra)}")
            return self.errors(value, self.resolve(schema["$ref"]), path)
        unknown = set(schema) - KEYWORDS - ANNOTATIONS
        if unknown:
            raise ValueError(f"unsupported keywords at {path}: {sorted(unknown)}")
        if "type" in schema:
            kinds = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
            if not any(_kind_ok(value, kind) for kind in kinds):
                return [f"{path}: expected {'/'.join(kinds)}, got {type(value).__name__}"]
        found = []
        if "const" in schema and not _same(value, schema["const"]):
            found.append(f"{path}: expected {schema['const']!r}")
        if "enum" in schema and not any(_same(value, item) for item in schema["enum"]):
            found.append(f"{path}: {value!r} is not one of {schema['enum']!r}")
        if "oneOf" in schema:
            matches = [index for index, sub in enumerate(schema["oneOf"]) if not self.errors(value, sub, path)]
            if len(matches) != 1:
                found.append(f"{path}: matched {len(matches)} of {len(schema['oneOf'])} options, not one")
        if isinstance(value, dict):
            found.extend(self._object(value, schema, path))
        if isinstance(value, list):
            found.extend(self._array(value, schema, path))
        if isinstance(value, str):
            found.extend(self._string(value, schema, path))
        if isinstance(value, (int, float)) and not isinstance(value, bool) and "minimum" in schema and value < schema["minimum"]:
            found.append(f"{path}: {value!r} is below {schema['minimum']!r}")
        return found

    def _object(self, value, schema, path):
        found = []
        for name in schema.get("required", []):
            if name not in value:
                found.append(f"{path}: missing {name!r}")
        properties = schema.get("properties", {})
        for name, item in value.items():
            if name in properties:
                found.extend(self.errors(item, properties[name], f"{path}.{name}"))
            elif schema.get("additionalProperties") is False:
                found.append(f"{path}: extra field {name!r}")
            elif isinstance(schema.get("additionalProperties"), dict):
                found.extend(self.errors(item, schema["additionalProperties"], f"{path}.{name}"))
        return found

    def _array(self, value, schema, path):
        found = []
        if "minItems" in schema and len(value) < schema["minItems"]:
            found.append(f"{path}: fewer than {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            found.append(f"{path}: more than {schema['maxItems']} items")
        if "items" in schema:
            for index, item in enumerate(value):
                found.extend(self.errors(item, schema["items"], f"{path}[{index}]"))
        return found

    def _string(self, value, schema, path):
        found = []
        if "minLength" in schema and len(value) < schema["minLength"]:
            found.append(f"{path}: shorter than {schema['minLength']}")
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            found.append(f"{path}: does not match {schema['pattern']!r}")
        if schema.get("format") == "date-time" and not _date_time(value):
            found.append(f"{path}: {value!r} is not a date and time with an offset")
        elif "format" in schema and schema["format"] != "date-time":
            raise ValueError(f"unsupported format {schema['format']!r} at {path}")
        return found

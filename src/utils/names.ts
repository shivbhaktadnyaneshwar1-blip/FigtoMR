const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isPascalCase(value: string): boolean {
  return PASCAL_CASE.test(value);
}

export function isKebabCase(value: string): boolean {
  return KEBAB_CASE.test(value);
}

export function toPascalCase(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  const result = cleaned.join('');
  if (!isPascalCase(result)) {
    throw new Error(`Unable to convert "${value}" into a PascalCase component name.`);
  }
  return result;
}

export function toKebabCase(value: string): string {
  const kebab = value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  if (!isKebabCase(kebab)) {
    throw new Error(`Unable to convert "${value}" into a kebab-case folder name.`);
  }
  return kebab;
}

export function assertPascalComponentName(value: string): string {
  if (!isPascalCase(value)) {
    throw new Error(`Component name must be PascalCase (e.g. SummaryCard). Received: "${value}".`);
  }
  return value;
}

export function symbolPrefix(pascalName: string): string {
  return assertPascalComponentName(pascalName);
}

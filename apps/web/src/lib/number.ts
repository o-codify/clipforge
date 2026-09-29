const plural = new Intl.PluralRules("ru");
export function counted(value: number, one: string, few: string, many: string) {
  const form = plural.select(value);
  return `${value.toLocaleString("ru-RU")} ${form === "one" ? one : form === "few" ? few : many}`;
}

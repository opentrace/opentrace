// Known limitation: generator_function_declaration is not in FUNCTION_TYPES,
// so generator functions are not extracted.
function* range(start: number, end: number) {
  for (let i = start; i < end; i++) {
    yield i;
  }
}

// Known limitation: concise arrow body IS the call_expression node itself,
// so collectCalls (which checks children) misses it.
const run = () => execute();

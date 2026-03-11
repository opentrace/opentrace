function orchestrate() {
  setup();
  console.log("started");
  this.validate();
}
const dispatch = (event: string) => {
  emit(event);
  logger.info(event);
};

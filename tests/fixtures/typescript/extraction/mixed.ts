class Config {
  get value() {
    return this._value;
  }
}
function setup(opts: Options) {
  init(opts);
  db.connect();
}
const run = () => {
  execute();
};

class UserService {
  constructor(private db: Database) {}
  getUser(id: string) {
    return this.db.find(id);
  }
}
export class AppModule {}

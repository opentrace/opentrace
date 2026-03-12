public interface IRepository {
    void Save(object item);
    object FindById(string id);
}

public interface IDisposable {
    void Dispose();
}

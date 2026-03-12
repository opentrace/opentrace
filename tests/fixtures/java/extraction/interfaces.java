public interface Repository {
    void save(Object item);
    Object findById(String id);
    void delete(String id);
}

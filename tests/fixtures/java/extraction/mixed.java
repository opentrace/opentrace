public class User {
    private String name;

    public User(String name) {
        this.name = name;
    }

    public String getName() {
        return name;
    }
}

public enum Role {
    ADMIN,
    USER,
    GUEST;
}

public interface Serializable {
    byte[] serialize();
}

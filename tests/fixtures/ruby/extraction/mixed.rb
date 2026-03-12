class Dog
  def bark
    "woof"
  end
end

module Serializable
  def serialize
    to_json
  end
end

class Cat
  def meow
    "meow"
  end
end

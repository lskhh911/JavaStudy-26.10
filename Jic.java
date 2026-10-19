public class Jic {
    public static void main(String[] args) {
        PrimaryStudent a = new PrimaryStudent("恺哥", 15, 59, 8);

        System.out.println("his grade is : " + a.getGrade());
    }
}

class Person {
    protected String name;
    protected int age;

    public Person(String name, int age) {
        this.name = name;
        this.age = age;
    }

    public Person() {}

    public String getName() { return this.name; }
    public int getAge() { return this.age; }
    public void setName(String name) { this.name = name; }
    public void setAge(int age) { this.age = age; }
}

class Student extends Person {
    protected int score;

    public void setScore(int score) { this.score = score; }

    public int getScore() { return this.score; }

    public Student(String name, int age, int score) {
        super(name, age);
        this.score = score;
    }

    public void hello() {
        System.out.println("Hello, " + super.name + "! ");
    }
}

class PrimaryStudent extends Student {
    private int grade;

    public PrimaryStudent(String name, int age, int score, int grade) {
        super(name, age, score);
        this.grade = grade;
    }

    public void setGrade(int grade) {
        this.grade = grade;
    }

    public int getGrade() {
        return this.grade;
    }
}
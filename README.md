10.15:

git HelloWorld文件

10.16输入：

import java.util.Scanner;
	
public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        
        // 读取上次考试成绩和本次考试成绩
        int lastScore = sc.nextInt();
        int currentScore = sc.nextInt();

10.16 继承：

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

import java.util.Scanner;
	
public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        
        // 读取上次考试成绩和本次考试成绩
        int lastScore = sc.nextInt();
        int currentScore = sc.nextInt();
        
        // 计算提高的百分比，注意使用浮点数运算避免整数除法
        double percent = (currentScore - lastScore) * 100.0 / lastScore;
        
        // 输出结果，保留两位小数并加上百分号
        System.out.printf("%.2f%%", percent);
        
        sc.close();
    }
}

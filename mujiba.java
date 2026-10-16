public class mujiba {
	public static void main (String[] args) {
		String fruit = "Apple";
		int mjb = switch(fruit) {
			case "Apple" -> 1;
			case "Pear" -> 2;
			default -> 3;
		};
		System.out.println("here is " + mjb);
	}
}

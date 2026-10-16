// City
public class CityTest {
    public static void main(String[] args) {
        City bj = new City();
        bj.name = "Beijing";
        Double latitude = bj.get_lat();
        Double longitude = bj.get_log();
        System.out.println(bj.name);
        System.out.println("location: " + latitude + ", " + longitude);
    }
}

class City {
	public String name;
	private Double latitude = 10.0;
	private Double longitude = 20.0;
	public Double get_lat() {
		return this.latitude;
	}
	public Double get_log() {
		return this.longitude;
	}
}

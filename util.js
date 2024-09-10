module.exports = {
  generateRandomNumberCode: function (length) {
    let result = "";
    const characters = "0123456789";
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
  },
  getPublicIpv4: async function () {
    try {
      const response = await axios.get("https://icanhazip.com");
      return response.data.trim(); // IP 주소 반환 (공백 제거)
    } catch (error) {
      console.error("Error retrieving public IP address:", error);
      throw new Error("Failed to fetch public IP address");
    }
  },
};

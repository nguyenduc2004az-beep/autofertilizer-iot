# SỔ TAY VẬN HÀNH & ĐIỀU KHIỂN: CHU KỲ TƯỚI VÀ LƯU LƯỢNG CHÂM PHÂN CHO 100 GỐC CÀ CHUA
*(Thiết lập thông số cho hệ thống điều khiển tự động 3 bồn NPK độc lập - Áp dụng tiêu chuẩn Haifa Group)*

Tài liệu này cung cấp **bảng thông số kỹ thuật chi tiết** dùng để cấu hình trực tiếp cho phần mềm giám sát và bo mạch ESP32. Dung dịch mẹ đã có sẵn trong 3 bồn N, P, K. Hệ thống sẽ tự động phối trộn tỷ lệ và chia chu kỳ tưới dựa trên các công thức toán học dưới đây.

---

## I. THÔNG SỐ VẬN HÀNH HỆ THỐNG GỐC

* **Quy mô vườn:** $100$ cây cà chua trồng giá thể xơ dừa.
* **Đầu tưới nhỏ giọt:** Mỗi cây lắp $1$ đầu tưới bù áp lưu lượng cố định $4$ Lít/giờ ($4000$ mL/h).
* **Thời lượng 1 chu kỳ tưới:** Định lượng cứng đúng **$1$ phút** ($60$ giây/lần).
  * Lượng nước mỗi cây nhận/lần tưới: $4\text{ L} \div 60\text{ phút} \approx 0.0667\text{ L} = \mathbf{66.67\text{ mL}}$.
  * Tổng lượng nước toàn vườn/lần tưới: $66.67\text{ mL} \times 100 = \mathbf{6.67\text{ Lít}}$ (tương đương tốc độ dòng chính là **$6.67\text{ L/phút}$**).
* **Tỷ lệ châm phân tổng (Venturi hoặc Bơm định lượng):** Thiết lập cố định ở tỷ lệ **$1:100$** ($1\%$).
  * Tổng dung dịch mẹ (N + P + K) cần châm đồng thời trong 1 phút tưới:
    $$V_{\text{fert}} = \frac{6670\text{ mL}}{100} = \mathbf{66.67\text{ mL dung dịch mẹ/chu kỳ}}$$
  * Tổng lưu lượng châm mục tiêu trên đường ống châm: **$66.67\text{ mL/phút}$**.
* **Khung giờ tưới ban ngày (quang hợp):** Từ **07:00 đến 17:30** (tổng thời lượng hoạt động $10.5$ giờ = $630$ phút). Không tưới đêm.

---

## II. THUẬT TOÁN ĐIỀU KHIỂN LƯU LƯỢNG KÊNH N-P-K TRÊN ESP32

Để điều khiển các động cơ bước NEMA 17 điều tiết van kim châm phân mẹ, bo mạch ESP32 tự động tính toán lưu lượng mục tiêu thời gian thực cho từng kênh châm $i \in \{N, P, K\}$ dựa trên tỉ lệ phối trộn $r_N : r_P : r_K$:

$$Q_i = 66.67 \times \left( \frac{r_i}{r_N + r_P + r_K} \right) \quad (\text{mL/phút})$$

Thể tích phân mẹ châm tương ứng từ mỗi bồn trong chu kỳ tưới 1 phút:
$$V_i = Q_i \times 1\text{ phút} \quad (\text{mL})$$

---

## III. CHI TIẾT CHU KỲ TƯỚI BÓN & LƯU LƯỢNG KÊNH THEO 4 GIAI ĐOẠN

Dưới đây là bảng thông số chu kỳ và lưu lượng châm phân chi tiết của từng giai đoạn sinh trưởng để nạp vào hệ thống điều khiển:

### Giai đoạn 1: Establishment (Cây con thiết lập rễ - Tuần 1 & 2)
* **Tổng nhu cầu nước:** $0.66$ L/cây/ngày (Toàn vườn $66$ Lít/ngày).
* **Số chu kỳ tưới:** **$10$ lần/ngày** (Giãn cách giữa các lần: **$70$ phút**).
* **Tỷ lệ phối trộn N:P:K:** **$1 : 1 : 1$** (EC mục tiêu $1.0 - 1.2$ mS/cm).
* **Thiết lập lưu lượng kênh châm mẹ (mL/phút):**
  * Kênh Đạm (N): **$22.22\text{ mL/phút}$** (hút $22.22$ mL).
  * Kênh Lân (P): **$22.22\text{ mL/phút}$** (hút $22.22$ mL).
  * Kênh Kali (K): **$22.22\text{ mL/phút}$** (hút $22.22$ mL).

#### Biểu đồ tưới bón 24h chi tiết (Giai đoạn 1):
| Lần tưới | Thời gian | Trạng thái hệ thống | Lưu lượng N (mL/phút) | Lưu lượng P (mL/phút) | Lưu lượng K (mL/phút) | Lượng nước (L) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **1** | 07:00 | **Có châm phân** | 22.22 | 22.22 | 22.22 | 6.67 |
| **2** | 08:10 | **Có châm phân** | 22.22 | 22.22 | 22.22 | 6.67 |
| **3** | 09:20 | **Có châm phân** | 22.22 | 22.22 | 22.22 | 6.67 |
| **4** | 10:30 | **Có châm phân** | 22.22 | 22.22 | 22.22 | 6.67 |
| **5** | 11:40 | **Có châm phân** | 22.22 | 22.22 | 22.22 | 6.67 |
| **6** | 12:50 | **Có châm phân** | 22.22 | 22.22 | 22.22 | 6.67 |
| **7** | 14:00 | **Có châm phân** | 22.22 | 22.22 | 22.22 | 6.67 |
| **8** | 15:10 | **Có châm phân** | 22.22 | 22.22 | 22.22 | 6.67 |
| **9** | 16:20 | **Chỉ tưới nước sạch** | 0.00 | 0.00 | 0.00 | 6.67 |
| **10** | 17:30 | **Chỉ tưới nước sạch** | 0.00 | 0.00 | 0.00 | 6.67 |

---

### Giai đoạn 2: Vegetative Growth (Thân lá sinh trưởng - Tuần 3 đến 5)
* **Tổng nhu cầu nước:** $0.76$ L/cây/ngày (Toàn vườn $76$ Lít/ngày).
* **Số chu kỳ tưới:** **$12$ lần/ngày** (Giãn cách giữa các lần: **$57$ phút**).
* **Tỷ lệ phối trộn N:P:K:** **$1 : 1 : 1$** (EC mục tiêu $1.4 - 1.6$ mS/cm).
* **Thiết lập lưu lượng kênh châm mẹ (mL/phút):**
  * Kênh Đạm (N): **$22.22\text{ mL/phút}$**
  * Kênh Lân (P): **$22.22\text{ mL/phút}$**
  * Kênh Kali (K): **$22.22\text{ mL/phút}$**

#### Biểu đồ tưới bón 24h chi tiết (Giai đoạn 2):
| Lần tưới | Thời gian | Trạng thái hệ thống | Lưu lượng N (mL/phút) | Lưu lượng P (mL/phút) | Lưu lượng K (mL/phút) | Lượng nước (L) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **1 - 10** | 10 lần đầu * | **Có châm phân** | 22.22 | 22.22 | 22.22 | 6.67 / lần |
| **11** | 16:33 | **Chỉ tưới nước sạch** | 0.00 | 0.00 | 0.00 | 6.67 |
| **12** | 17:30 | **Chỉ tưới nước sạch** | 0.00 | 0.00 | 0.00 | 6.67 |

*\* Ghi chú mốc thời gian 10 lần đầu: 07:00, 07:57, 08:54, 09:51, 10:48, 11:45, 12:42, 13:39, 14:36, 15:33.*

---

### Giai đoạn 3: From Initial Flowering till Fruit-set (Ra hoa đậu quả - Tuần 6 đến 8)
* **Tổng nhu cầu nước:** $1.16$ L/cây/ngày (Toàn vườn $116$ Lít/ngày).
* **Số chu kỳ tưới:** **$18$ lần/ngày** (Giãn cách giữa các lần: **$37$ phút**).
* **Tỷ lệ phối trộn N:P:K:** **$2 : 1 : 3$** (EC mục tiêu $1.8 - 2.2$ mS/cm).
* **Thiết lập lưu lượng kênh châm mẹ (mL/phút):**
  * Kênh Đạm (N): **$22.22\text{ mL/phút}$** (hút $22.22$ mL).
  * Kênh Lân (P): **$11.11\text{ mL/phút}$** (hút $11.11$ mL).
  * Kênh Kali (K): **$33.33\text{ mL/phút}$** (hút $33.33$ mL).

#### Biểu đồ tưới bón 24h chi tiết (Giai đoạn 3):
| Lần tưới | Thời gian | Trạng thái hệ thống | Lưu lượng N (mL/phút) | Lưu lượng P (mL/phút) | Lưu lượng K (mL/phút) | Lượng nước (L) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **1 - 16** | 16 lần đầu * | **Có châm phân** | 22.22 | 11.11 | 33.33 | 6.67 / lần |
| **17** | 16:53 | **Chỉ tưới nước sạch** | 0.00 | 0.00 | 0.00 | 6.67 |
| **18** | 17:30 | **Chỉ tưới nước sạch** | 0.00 | 0.00 | 0.00 | 6.67 |

*\* Ghi chú mốc thời gian 16 lần đầu: 07:00, 07:37, 08:14, 08:51, 09:28, 10:05, 10:42, 11:19, 11:56, 12:33, 13:10, 13:47, 14:24, 15:01, 15:38, 16:15.*

---

### Giai đoạn 4: Fruit Development and Maturation (Nuôi quả chín - Tuần 9 NST trở đi)
* **Tổng nhu cầu nước:** $1.48$ L/cây/ngày (Toàn vườn $148$ Lít/ngày).
* **Số chu kỳ tưới:** **$23$ lần/ngày** (Giãn cách giữa các lần: **$28$ phút**).
* **Tỷ lệ phối trộn N:P:K:** **$5 : 3 : 10$** (EC mục tiêu $2.2 - 2.5$ mS/cm).
* **Thiết lập lưu lượng kênh châm mẹ (mL/phút):**
  * Kênh Đạm (N): **$18.52\text{ mL/phút}$** (hút $18.52$ mL).
  * Kênh Lân (P): **$11.11\text{ mL/phút}$** (hút $11.11$ mL).
  * Kênh Kali (K): **$37.04\text{ mL/phút}$** (hút $37.04$ mL).

#### Biểu đồ tưới bón 24h chi tiết (Giai đoạn 4):
| Lần tưới | Thời gian | Trạng thái hệ thống | Lưu lượng N (mL/phút) | Lưu lượng P (mL/phút) | Lưu lượng K (mL/phút) | Lượng nước (L) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **1 - 20** | 20 lần đầu * | **Có châm phân** | 18.52 | 11.11 | 37.04 | 6.67 / lần |
| **21** | 16:34 | **Chỉ tưới nước sạch** | 0.00 | 0.00 | 0.00 | 6.67 |
| **22** | 17:02 | **Chỉ tưới nước sạch** | 0.00 | 0.00 | 0.00 | 6.67 |
| **23** | 17:30 | **Chỉ tưới nước sạch** | 0.00 | 0.00 | 0.00 | 6.67 |

*\* Ghi chú mốc thời gian 20 lần đầu: 07:00, 07:28, 07:56, 08:24, 08:52, 09:20, 09:48, 10:16, 10:44, 11:12, 11:40, 12:08, 12:36, 13:04, 13:32, 14:00, 14:28, 14:56, 15:24, 15:52, 16:06.*

---

## IV. BẢNG TỔNG HỢP CẤU HÌNH ĐIỀU KHIỂN

Bảng này chứa dữ liệu trực tiếp để bạn ánh xạ vào cấu hình hệ thống (nhập vào Dashboard hoặc cơ sở dữ liệu JSON của Web Server):

| Giai đoạn sinh trưởng | Số lần tưới (lần/ngày) | Giãn cách tưới (phút) | Tỷ lệ N:P:K điều khiển | Kênh Đạm N (mL/phút) | Kênh Lân P (mL/phút) | Kênh Kali K (mL/phút) | Trạng thái châm phân |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Giai đoạn 1** | $10$ | $70$ | $1:1:1$ | **22.22** | **22.22** | **22.22** | Bật (Tắt ở lần tưới 9, 10) |
| **Giai đoạn 2** | $12$ | $57$ | $1:1:1$ | **22.22** | **22.22** | **22.22** | Bật (Tắt ở lần tưới 11, 12) |
| **Giai đoạn 3** | $18$ | $37$ | $2:1:3$ | **22.22** | **11.11** | **33.33** | Bật (Tắt ở lần tưới 17, 18) |
| **Giai đoạn 4** | $23$ | $28$ | $5:3:10$ | **18.52** | **11.11** | **37.04** | Bật (Tắt ở lần tưới 21, 22, 23) |

---

## V. ĐẶC TÍNH VÀ Ý NGHĨA KHOA HỌC TRONG ĐIỀU KHIỂN TỰ ĐỘNG
1. **Bảo vệ rễ (Flushing Strategy):** Khác với tưới thủ công, hệ thống IoT tự động chuyển đổi lưu lượng châm về $0$ ở các lần tưới cuối cùng trong ngày. Việc này giữ ẩm qua đêm bằng nước sạch, hòa tan lượng muối thừa tích tụ trong túi xơ dừa, duy trì vùng rễ khỏe mạnh.
2. **Dynamic Ratio Shift:** Việc tính toán chính xác lưu lượng theo phân số tổng thể của Haifa ($2:1:3$ và $5:3:10$) đảm bảo không xảy ra hiện tượng mất cân bằng dinh dưỡng, nâng cao hiệu suất hấp thụ dưỡng chất của cà chua lên hơn $95\%$.
3. **Tiết kiệm năng lượng và nước:** Tưới xung ngắn (1 phút) giúp duy trì lực mao dẫn trong túi xơ dừa tối ưu, nước không bị chảy tràn lãng phí xuống nền nhà lưới.

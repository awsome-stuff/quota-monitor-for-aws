# EC2 Quotas

```
| QuotaCode  | QuotaName                                                        | Value  | Adjustable |
| ---------- | ---------------------------------------------------------------- | ------ | ---------- |
| L-0263D0A3 | EC2-VPC Elastic IPs                                              | 5      | Yes        |
| L-0E3CBAB9 | Public AMIs                                                      | 5      | Yes        |
| L-1216C47A | Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances | 1,152  | Yes        |
| L-1945791B | Running On-Demand Inf instances                                  | 128    | Yes        |
| L-2C3B7624 | Running On-Demand Trn instances                                  | 256    | Yes        |
| L-34B43A08 | All Standard (A, C, D, H, I, M, R, T, Z) Spot Instance Requests  | 1,152  | Yes        |
| L-3819A6DF | All G and VT Spot Instance Requests                              | 64     | Yes        |
| L-3E6EC3A3 | VPN connections per region                                       | 50     | Yes        |
| L-417A185B | Running On-Demand P instances                                    | 384    | Yes        |
| L-43872EB7 | Route Tables per transit gateway                                 | 20     | Yes        |
| L-43DA4232 | Running On-Demand High Memory instances                          | 448    | Yes        |
| L-4FB7FF5D | Customer gateways per region                                     | 50     | Yes        |
| L-62499967 | Pending peering attachments per transit gateway                  | 10     | Yes        |
| L-6B0D517C | All Trn Spot Instance Requests                                   | 256    | Yes        |
| L-6E869C2A | Running On-Demand DL instances                                   | 96     | Yes        |
| L-7029FAB6 | Virtual private gateways per region                              | 5      | Yes        |
| L-7212CCBC | All P Spot Instance Requests                                     | 768    | Yes        |
| L-7295265B | Running On-Demand X instances                                    | 128    | Yes        |
| L-74FC7D96 | Running On-Demand F instances                                    | 128    | Yes        |
| L-7A108150 | VPN connections per VPN concentrator                             | 100    | Yes        |
| L-85EED4F7 | All DL Spot Instance Requests                                    | 96     | Yes        |
| L-88CF9481 | All F Spot Instance Requests                                     | 128    | Yes        |
| L-A1B5A36F | Peering attachments per transit gateway                          | 50     | Yes        |
| L-A2478D36 | Transit gateways per account                                     | 5      | Yes        |
| L-B5D1601B | All Inf Spot Instance Requests                                   | 128    | Yes        |
| L-B665C33B | AMIs                                                             | 50,000 | Yes        |
| L-B6F46B9C | VPN concentrators per region                                     | 5      | Yes        |
| L-B91E5754 | VPN connections per VGW                                          | 10     | Yes        |
| L-DB2E81BA | Running On-Demand G and VT instances                             | 64     | Yes        |
| L-E0233F82 | Attachments per transit gateway                                  | 5,000  | Yes        |
| L-E3A00192 | All X Spot Instance Requests                                     | 128    | Yes        |
| L-F7808C92 | Running On-Demand HPC instances                                  | 768    | Yes        |
```

All list:
```
L-0263D0A3,L-0E3CBAB9,L-1216C47A,L-1945791B,L-2C3B7624,L-34B43A08,L-3819A6DF,L-3E6EC3A3,L-417A185B,L-43872EB7,L-43DA4232,L-4FB7FF5D,L-62499967,L-6B0D517C,L-6E869C2A,L-7029FAB6,L-7212CCBC,L-7295265B,L-74FC7D96,L-7A108150,L-85EED4F7,L-88CF9481,L-A1B5A36F,L-A2478D36,L-B5D1601B,L-B665C33B,L-B6F46B9C,L-B91E5754,L-DB2E81BA,L-E0233F82,L-E3A00192,L-F7808C92
```

Of interest:
```
L-1216C47A,L-1945791B,L-2C3B7624,L-34B43A08,L-417A185B,L-43DA4232,L-6E869C2A,L-7295265B,L-74FC7D96,L-DB2E81BA,L-F7808C92
```
